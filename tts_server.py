import asyncio
import edge_tts
import sys
import json

async def generate(text, voice):
    communicate = edge_tts.Communicate(text, voice)
    await communicate.save("/tmp/output.mp3")

data = json.loads(sys.argv[1])
asyncio.run(generate(data["text"], data.get("voice", "en-US-GuyNeural")))
