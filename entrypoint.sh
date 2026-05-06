#!/bin/sh
# On first boot (empty volume), copy seed files into the data directory.
mkdir -p /app/data/uploads /app/data/chunk_images
[ -f /app/data/curriculum.json ] || cp /app/seed/curriculum.json /app/data/curriculum.json
[ -f /app/data/ai-rules.md ]     || cp /app/seed/ai-rules.md     /app/data/ai-rules.md
exec uvicorn backend.main:app --host 0.0.0.0 --port "${PORT:-8000}"
