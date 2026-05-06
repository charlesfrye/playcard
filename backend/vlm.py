import asyncio
import json
import subprocess
import time

import aiohttp
import modal
import modal.experimental

MINUTES = 60

sglang_image = (
    modal.Image.from_registry("lmsysorg/sglang:v0.5.10.post1-cu130-runtime")
    .entrypoint([])
    .uv_pip_install("decord==0.6.0")
)

MODEL_NAME = "Qwen/Qwen3.6-35B-A3B-FP8"
MODEL_REVISION = "95a723d08a9490559dae23d0cff1d9466213d989"

GPU = "H100!:1"
N_GPUS = 1

HF_CACHE_VOL = modal.Volume.from_name("huggingface-cache", create_if_missing=True)
HF_CACHE_PATH = "/root/.cache/huggingface"

DG_CACHE_VOL = modal.Volume.from_name("deepgemm-cache", create_if_missing=True)
DG_CACHE_PATH = "/root/.cache/deepgemm"

sglang_image = sglang_image.env(
    {
        "HF_HUB_CACHE": HF_CACHE_PATH,
        "HF_XET_HIGH_PERFORMANCE": "1",
        "SGLANG_ENABLE_JIT_DEEPGEMM": "1",
        "SGLANG_USE_CUDA_IPC_TRANSPORT": "1",
        "SGLANG_USE_IPC_POOL_HANDLE_CACHE": "1",
    }
)


def compile_deep_gemm():
    import os
    import subprocess

    if int(os.environ.get("SGLANG_ENABLE_JIT_DEEPGEMM", "1")):
        subprocess.run(
            f"python3 -m sglang.compile_deep_gemm --model-path {MODEL_NAME} --revision {MODEL_REVISION} --tp {N_GPUS}",
            shell=True,
            check=True,
        )


sglang_image = sglang_image.run_function(
    compile_deep_gemm,
    volumes={DG_CACHE_PATH: DG_CACHE_VOL, HF_CACHE_PATH: HF_CACHE_VOL},
    gpu=GPU,
)

PROXY_REGION = "us-west"

PORT = 8000
TARGET_INPUTS = 10

app = modal.App(name="playcard-backend")


@app.cls(
    image=sglang_image,
    gpu=GPU,
    volumes={HF_CACHE_PATH: HF_CACHE_VOL, DG_CACHE_PATH: DG_CACHE_VOL},
    timeout=15 * MINUTES,
    scaledown_window=20 * MINUTES,
    region="us-west",
    min_containers=1,
)
@modal.experimental.http_server(port=PORT, proxy_regions=[PROXY_REGION])
@modal.concurrent(target_inputs=TARGET_INPUTS)
class VlmServer:
    @modal.enter()
    def startup(self):
        self.process = _start_server()
        wait_ready(self.process)
        warmup()

    @modal.exit()
    def stop(self):
        self.process.terminate()
        self.process.wait()


def _start_server() -> subprocess.Popen:
    """Start SGLang server in a subprocess"""
    cmd = [
        "python",
        "-m",
        "sglang.launch_server",
        "--model-path",
        MODEL_NAME,
        "--revision",
        MODEL_REVISION,
        "--served-model-name",
        MODEL_NAME,
        "--host",
        "0.0.0.0",
        "--port",
        f"{PORT}",
        "--tp",
        f"{N_GPUS}",
        "--cuda-graph-max-bs",
        f"{TARGET_INPUTS * 2}",
        "--enable-metrics",
        "--mem-fraction-static",
        "0.8",
        "--context-length",
        "262_144",
        "--mamba-scheduler-strategy",
        "extra_buffer",
        "--reasoning-parser",
        "qwen3",
        "--tool-call-parser",
        "qwen3_coder",
        "--speculative-algo",
        "EAGLE",
        "--speculative-num-steps",
        "3",
        "--speculative-eagle-topk",
        "1",
        "--speculative-num-draft-tokens",
        "4",
    ]

    print("Starting SGLang server with command:")
    print(*cmd)

    return subprocess.Popen(" ".join(cmd), shell=True, start_new_session=True)


def wait_ready(process: subprocess.Popen, timeout: int = 10 * MINUTES):
    import requests

    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            check_running(process)
            requests.get(f"http://127.0.0.1:{PORT}/health").raise_for_status()
            return
        except (
            subprocess.CalledProcessError,
            requests.exceptions.ConnectionError,
            requests.exceptions.HTTPError,
        ):
            time.sleep(5)
    raise TimeoutError(f"SGLang server not ready within {timeout} seconds")


def check_running(p: subprocess.Popen):
    if (rc := p.poll()) is not None:
        raise subprocess.CalledProcessError(rc, cmd=p.args)


SAMPLE_PAYLOAD = {
    "messages": [
        {
            "role": "user",
            "content": [
                {
                    "type": "image_url",
                    "image_url": {
                        "url": "https://modal-cdn.com/golden-gate-bridge.jpg"
                    },
                },
                {"type": "text", "text": "What is this?"},
            ],
        }
    ],
    "max_tokens": 16,
}

VIDEO_SAMPLE_PAYLOAD = {
    "messages": [
        {
            "role": "user",
            "content": [
                {
                    "type": "video_url",
                    "video_url": {
                        "url": "https://qianwen-res.oss-accelerate.aliyuncs.com/Qwen3.5/demo/video/N1cdUjctpG8.mp4"
                    },
                },
                {"type": "text", "text": "Describe this video briefly."},
            ],
        }
    ],
    "max_tokens": 64,
}


def warmup():
    import requests

    for payload in (SAMPLE_PAYLOAD, VIDEO_SAMPLE_PAYLOAD):
        requests.post(
            f"http://127.0.0.1:{PORT}/v1/chat/completions",
            json=payload,
            timeout=300,
        ).raise_for_status()


@app.local_entrypoint()
async def main(prompt: str | None = None, video: bool = False):
    url = (await VlmServer._experimental_get_flash_urls.aio())[0]

    payload = VIDEO_SAMPLE_PAYLOAD if video else SAMPLE_PAYLOAD
    messages = payload["messages"]
    if prompt is not None:
        messages[-1]["content"][-1] = {"type": "text", "text": prompt}
    media_key = "video_url" if video else "image_url"
    print(f"Sending {media_key} at {messages[0]['content'][0][media_key]['url']} to the server")

    await probe(url, messages, timeout=10 * MINUTES)


async def probe(url: str, messages: list, timeout: int = 5 * MINUTES):
    deadline = time.time() + timeout

    async with aiohttp.ClientSession(base_url=url) as session:
        while time.time() < deadline:
            try:
                await _send_request_streaming(session, messages)
                return
            except asyncio.TimeoutError:
                await asyncio.sleep(1)
            except aiohttp.client_exceptions.ClientResponseError as e:
                if e.status == 503:
                    await asyncio.sleep(1)
                    continue
                raise
    raise TimeoutError(f"No response from server within {timeout} seconds")


async def _send_request_streaming(
    session: aiohttp.ClientSession, messages: list, timeout: int | None = None
) -> None:
    payload = {
        "messages": messages,
        "stream": True,
        "top_k": 20,
    }
    headers = {"Accept": "text/event-stream"}

    async with session.post(
        "/v1/chat/completions", json=payload, headers=headers, timeout=timeout
    ) as resp:
        resp.raise_for_status()
        full_text = ""

        chunk = ""
        async for raw in resp.content:
            line = raw.decode("utf-8", errors="ignore").strip()
            if not line:
                continue

            if not line.startswith("data:"):
                continue

            data = line[len("data:") :].strip()
            if data == "[DONE]":
                break

            try:
                evt = json.loads(data)
            except json.JSONDecodeError:
                continue

            delta = (evt.get("choices") or [{}])[0].get("delta") or {}
            chunk += delta.get("content") or delta.get("reasoning_content") or ""

            if chunk and ("." in chunk or "\n" in chunk):
                print(chunk, end="", flush=True)
                full_text += chunk
                chunk = ""

        if chunk:
            print(chunk, end="", flush=True)
            full_text += chunk

        print()
        return full_text
