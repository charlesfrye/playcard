from pathlib import Path

import modal

app = modal.App("playcard-test-frontend")

__here__ = Path(__file__).parent

image = modal.Image.debian_slim().add_local_file(__here__ / "index.html", "/root/index.html")
PORT = 8000


@app.function(image=image)
@modal.concurrent(max_inputs=100)
@modal.web_server(port=PORT)
def serve():
    import subprocess

    subprocess.run(["touch", "index.html"])

    subprocess.Popen(["python", "-m", "http.server", f"{PORT}"])
