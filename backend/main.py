import os
import json
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from backend.db import engine, Base
from backend.routers import documents, sections, cards, generate, curriculum, rules, export, usage, review_marks, fix_batches
from backend import models  # noqa — ensure all models registered

STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")


def seed_data():
    from sqlalchemy.orm import Session
    from backend.config import DATA_DIR, SEED_DIR
    from backend.models import RuleSet, Curriculum

    with Session(engine) as db:
        # Seed generation rules from seed/ai-rules.md
        if db.query(RuleSet).filter_by(rule_type="generation").count() == 0:
            rules_path = os.path.join(SEED_DIR, "ai-rules.md")
            if os.path.exists(rules_path):
                with open(rules_path) as f:
                    content = f.read()
                db.add(RuleSet(name="Default (ai-rules v1.1)", rule_type="generation", content=content, is_default=True))
                db.commit()

        # Seed vignette + teaching case rules
        if not db.query(RuleSet).filter_by(rule_type="vignette").first():
            db.add(RuleSet(
                name="Default Vignette + Teaching Case Rules",
                rule_type="vignette",
                content="""You will receive a set of finished Anki cloze cards for a single condition. Generate both a clinical vignette (COLUMN 5) and a teaching case (COLUMN 6) for this condition.

For COLUMN 5 (Vignette): Write a 4-6 sentence clinical vignette that serves as a memorable anchor. Begin with a patient presentation using a memorable alliterative name tied to the diagnosis. Include hallmark signs, symptoms, and a key diagnostic finding. End with a clinical decision-making pearl.

For COLUMN 6 (Teaching Case): Write a comprehensive clinical teaching case using the same patient name. Include sections: Patient Presentation, Physical Examination, Workup and Diagnosis, Treatment, Follow Up and Monitoring, and PA EOR Board Pearls (5-8 numbered items).

STYLE: Second person present tense. Bold key clinical terms using <b> tags. Use <br> for line breaks. Do NOT use markdown. PA scope throughout.""",
                is_default=True,
            ))
            db.commit()

        # Seed curriculum from data/curriculum.json
        if db.query(Curriculum).count() == 0:
            curr_path = os.path.join(DATA_DIR, "curriculum.json")
            if os.path.exists(curr_path):
                with open(curr_path) as f:
                    tree = json.load(f)
                _seed_curriculum(db, tree, parent_id=None, level=0, parent_path="")
                db.commit()


def _seed_curriculum(db, nodes, parent_id, level, parent_path):
    from backend.models import Curriculum
    for idx, node in enumerate(nodes):
        path = f"{parent_path} > {node['name']}" if parent_path else node["name"]
        c = Curriculum(parent_id=parent_id, name=node["name"], level=level, path=path, sort_order=idx)
        db.add(c)
        db.flush()
        if node.get("children"):
            _seed_curriculum(db, node["children"], c.id, level + 1, path)


def _migrate_db():
    """Run lightweight SQLite migrations for new columns."""
    from sqlalchemy import text
    with engine.connect() as conn:
        # Add version column to curriculum if missing
        try:
            conn.execute(text("ALTER TABLE curriculum ADD COLUMN version VARCHAR(10) NOT NULL DEFAULT 'v1'"))
            conn.commit()
        except Exception:
            pass  # column already exists

        for col_sql in [
            "ALTER TABLE cards ADD COLUMN review_mark_id INTEGER REFERENCES review_mark_types(id)",
            "ALTER TABLE cards ADD COLUMN in_fix_batch BOOLEAN NOT NULL DEFAULT 0",
        ]:
            try:
                conn.execute(text(col_sql))
                conn.commit()
            except Exception:
                pass


@asynccontextmanager
async def lifespan(app: FastAPI):
    os.makedirs(os.path.join(os.path.dirname(__file__), "..", "data", "uploads"), exist_ok=True)
    Base.metadata.create_all(bind=engine)
    _migrate_db()
    seed_data()
    yield


app = FastAPI(title="EOR Card Studio v4", lifespan=lifespan)

app.include_router(documents.router, prefix="/api/topic-trees", tags=["documents"])
app.include_router(sections.router, prefix="/api/sections", tags=["sections"])
app.include_router(cards.router, prefix="/api/cards", tags=["cards"])
app.include_router(generate.router, prefix="/api/generate", tags=["generate"])
app.include_router(curriculum.router, prefix="/api/curriculum", tags=["curriculum"])
app.include_router(rules.router, prefix="/api/rules", tags=["rules"])
app.include_router(export.router, prefix="/api/export", tags=["export"])
app.include_router(usage.router, prefix="/api/usage", tags=["usage"])
app.include_router(review_marks.router, prefix="/api/review-marks", tags=["review_marks"])
app.include_router(fix_batches.router, prefix="/api/fix-batches", tags=["fix_batches"])


@app.post("/api/admin/clear-storage")
def clear_storage():
    """Clear uploaded files to free disk space."""
    import shutil
    from backend.config import DATA_DIR
    cleared = {}
    for subdir in ("uploads",):
        path = os.path.join(DATA_DIR, subdir)
        if os.path.exists(path):
            count = len(os.listdir(path))
            shutil.rmtree(path)
            os.makedirs(path, exist_ok=True)
            cleared[subdir] = count
    return {"cleared": cleared, "status": "ok"}


@app.get("/api/admin/disk-usage")
def disk_usage():
    """Show disk usage for data directory."""
    from backend.config import DATA_DIR
    usage_info = {}
    if not os.path.exists(DATA_DIR):
        return usage_info
    for item in os.listdir(DATA_DIR):
        path = os.path.join(DATA_DIR, item)
        if os.path.isfile(path):
            usage_info[item] = f"{os.path.getsize(path) / 1024 / 1024:.1f} MB"
        elif os.path.isdir(path):
            total = sum(
                os.path.getsize(os.path.join(dp, f))
                for dp, _, files in os.walk(path)
                for f in files
            )
            usage_info[item] = f"{total / 1024 / 1024:.1f} MB"
    return usage_info


if os.path.exists(STATIC_DIR) and os.listdir(STATIC_DIR):
    app.mount("/assets", StaticFiles(directory=os.path.join(STATIC_DIR, "assets")), name="assets")

    @app.get("/{full_path:path}")
    async def spa_fallback(full_path: str):
        if full_path.startswith("api/"):
            raise HTTPException(status_code=404)
        return FileResponse(os.path.join(STATIC_DIR, "index.html"))
