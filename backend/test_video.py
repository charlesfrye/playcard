import argparse
import json
import sys

import requests

DEFAULT_URL = "https://modal-labs-charles-dev--playcard-backend-vlmserver.us-west.modal.direct"

IMAGE_PAYLOAD = {
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
    "max_tokens": 128,
    "stream": True,
}

VIDEO_PAYLOAD = {
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
    "max_tokens": 256,
    "stream": True,
}


def main():
    parser = argparse.ArgumentParser(description="Test VLM backend")
    parser.add_argument("--url", default=DEFAULT_URL, help="Backend URL")
    parser.add_argument("--mode", choices=["image", "video"], default="video", help="Media type")
    parser.add_argument("--prompt", default=None, help="Override prompt text")
    parser.add_argument("--timeout", type=int, default=300)
    parser.add_argument("--no-stream", action="store_true", help="Disable streaming")
    parser.add_argument("--debug", action="store_true", help="Print response headers and raw chunks")
    args = parser.parse_args()

    src = VIDEO_PAYLOAD if args.mode == "video" else IMAGE_PAYLOAD
    payload = json.loads(json.dumps(src))
    if args.prompt is not None:
        payload["messages"][0]["content"][1]["text"] = args.prompt
    if args.no_stream:
        payload["stream"] = False

    url = f"{args.url}/v1/chat/completions"
    print(f"[{args.mode}] POST {url}")
    print(f"[{args.mode}] prompt: {payload['messages'][0]['content'][1]['text']}")
    print()

    resp = requests.post(
        url,
        json=payload,
        headers={"Accept": "text/event-stream"},
        stream=payload["stream"],
        timeout=args.timeout,
    )

    if args.debug:
        print(f"--- status: {resp.status_code}")
        print(f"--- headers: {dict(resp.headers)}")
        print()

    if not resp.ok:
        print(f"Error: HTTP {resp.status_code}")
        print(resp.text[:500])
        sys.exit(1)

    if payload["stream"]:
        buffer = ""
        for chunk in resp.iter_content(chunk_size=None):
            if not chunk:
                continue
            text = chunk.decode("utf-8", errors="ignore")
            if args.debug:
                print(f"[raw chunk] {text!r}")
            buffer += text
            while "\n\n" in buffer:
                message, buffer = buffer.split("\n\n", 1)
                for line in message.split("\n"):
                    line = line.strip()
                    if not line or not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        break
                    try:
                        evt = json.loads(data)
                        delta = evt.get("choices", [{}])[0].get("delta", {}) or {}
                        token = (delta.get("content") or "") + (delta.get("reasoning_content") or "")
                        if token:
                            print(token, end="", flush=True)
                    except json.JSONDecodeError:
                        if args.debug:
                            print(f"[bad json] {data!r}")
        if buffer.strip():
            if args.debug:
                print(f"[leftover buffer] {buffer!r}")
    else:
        data = resp.json()
        text = data.get("choices", [{}])[0].get("message", {}).get("content", str(data))
        print(text)

    print()


if __name__ == "__main__":
    main()