# Stage 1: Build frontend
FROM node:24-slim AS frontend

WORKDIR /app/frontend

COPY frontend/package.json ./
RUN npm install

COPY frontend/ ./
RUN npm run build


# Stage 2: Final image
FROM python:3.12-slim

WORKDIR /app

# Install Python dependencies
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Copy backend source
COPY backend/ ./backend/

# Bundle seed data (copied to /app/data/ by entrypoint on first boot)
COPY seed/ /app/seed/

# Copy entrypoint
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Copy built frontend static files from stage 1 (vite outDir: ../backend/static)
COPY --from=frontend /app/backend/static/ ./backend/static/

ENV PYTHONPATH=/app

EXPOSE 8000

ENTRYPOINT ["/app/entrypoint.sh"]
