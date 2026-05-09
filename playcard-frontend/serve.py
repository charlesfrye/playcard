from pathlib import Path

import modal

app = modal.App("playcard-frontend")

__here__ = Path(__file__).parent

image = (
    modal.Image.debian_slim()
    .add_local_file(__here__ / "index.html", "/root/index.html")
    .add_local_file(__here__ / "style.css", "/root/style.css")
    .add_local_file(__here__ / "app.js", "/root/app.js")
    .add_local_file(__here__ / "marked.min.js", "/root/marked.min.js")
)
PORT = 8000


@app.function(image=image)
@modal.concurrent(max_inputs=100)
@modal.web_server(port=PORT)
def serve():
    import subprocess

    subprocess.run(["touch", "index.html", "style.css", "app.js", "marked.min.js"])
    subprocess.Popen(["python", "-m", "http.server", f"{PORT}"])