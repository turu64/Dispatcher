from fastapi import FastAPI

app = FastAPI(title="Dispatcher server")


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
