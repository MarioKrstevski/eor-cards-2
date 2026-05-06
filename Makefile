.PHONY: dev-backend dev-frontend build test docker-build docker-run

dev-backend:
	PYTHONPATH=. .venv/bin/uvicorn backend.main:app --reload

dev-frontend:
	cd frontend && npm run dev

build:
	cd frontend && npm run build

test:
	.venv/bin/python -m pytest tests/ -v

docker-build:
	docker build -t eor-card-studio .

docker-run:
	docker run -p 8000:8000 -v $(PWD)/data:/app/data -e ANTHROPIC_API_KEY=$(ANTHROPIC_API_KEY) eor-card-studio
