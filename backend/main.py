import os
import json
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from backend.db import engine, Base, SessionLocal
from backend.routers import documents, sections, cards, generate, curriculum, rules, export, usage, review_marks, fix_batches, presentations, sbs, verify, lab
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

        # Seed / keep-in-sync the default Step-by-Step rule set from the seed file.
        # The DEFAULT is seed-managed (so prompt fixes propagate on deploy); the
        # reviewer customizes by DUPLICATING it — duplicates are never touched here.
        from backend.models import SbsRuleSet
        sbs_path = os.path.join(SEED_DIR, "sbs-default-prompt.txt")
        if os.path.exists(sbs_path):
            from backend.services.sbs_generator import split_prompt_into_sections
            with open(sbs_path) as f:
                sections = split_prompt_into_sections(f.read())
            default = db.query(SbsRuleSet).filter_by(name="Default Step-by-Step Rules").first()
            if default is None:
                db.add(SbsRuleSet(
                    name="Default Step-by-Step Rules", sections=sections,
                    is_default=(db.query(SbsRuleSet).count() == 0),
                ))
            else:
                default.sections = sections  # keep canonical default in sync with seed
            db.commit()

        # Seed curriculum from seed files (v1 + v2)
        if db.query(Curriculum).count() == 0:
            for version, filename in [("v1", "curriculum.json"), ("v2", "curriculum_v2.json")]:
                # Try seed/ first, fall back to data/
                seed_path = os.path.join(SEED_DIR, filename)
                data_path = os.path.join(DATA_DIR, filename)
                curr_path = seed_path if os.path.exists(seed_path) else data_path
                if os.path.exists(curr_path):
                    with open(curr_path) as f:
                        tree = json.load(f)
                    _seed_curriculum(db, tree, parent_id=None, level=0, parent_path="", version=version)
            db.commit()

        # Ensure the 'From split' / 'From combine' review marks exist up-front, so
        # they're in the UI's mark-type list at page load and the pills render
        # immediately after a split/combine (not created lazily on first use).
        from backend.services.card_ops import ensure_split_combine_marks
        ensure_split_combine_marks(db)
        db.commit()


def _seed_curriculum(db, nodes, parent_id, level, parent_path, version="v1"):
    from backend.models import Curriculum
    for idx, node in enumerate(nodes):
        path = f"{parent_path} > {node['name']}" if parent_path else node["name"]
        c = Curriculum(parent_id=parent_id, name=node["name"], level=level, path=path, sort_order=idx, version=version)
        db.add(c)
        db.flush()
        if node.get("children"):
            _seed_curriculum(db, node["children"], c.id, level + 1, path, version=version)


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
            "ALTER TABLE cards ADD COLUMN front_html_v1 TEXT",
            "ALTER TABLE cards ADD COLUMN front_html_v2 TEXT",
            "ALTER TABLE cards ADD COLUMN front_html_v3 TEXT",
            "ALTER TABLE cards ADD COLUMN extra_v1 TEXT",
            "ALTER TABLE cards ADD COLUMN extra_v2 TEXT",
            "ALTER TABLE cards ADD COLUMN extra_v3 TEXT",
            "ALTER TABLE cards ADD COLUMN accuracy_score_v1 INTEGER",
            "ALTER TABLE cards ADD COLUMN accuracy_score_v2 INTEGER",
            "ALTER TABLE cards ADD COLUMN accuracy_score_v3 INTEGER",
            "ALTER TABLE cards ADD COLUMN accuracy_note_v1 TEXT",
            "ALTER TABLE cards ADD COLUMN accuracy_note_v2 TEXT",
            "ALTER TABLE cards ADD COLUMN accuracy_note_v3 TEXT",
            "ALTER TABLE cards ADD COLUMN eor_yield_v1 TEXT",
            "ALTER TABLE cards ADD COLUMN eor_yield_v2 TEXT",
            "ALTER TABLE cards ADD COLUMN eor_yield_v3 TEXT",
            "ALTER TABLE cards ADD COLUMN correctness_score_v1 INTEGER",
            "ALTER TABLE cards ADD COLUMN correctness_score_v2 INTEGER",
            "ALTER TABLE cards ADD COLUMN correctness_score_v3 INTEGER",
            "ALTER TABLE cards ADD COLUMN correctness_v1 TEXT",
            "ALTER TABLE cards ADD COLUMN correctness_v2 TEXT",
            "ALTER TABLE cards ADD COLUMN correctness_v3 TEXT",
            "ALTER TABLE rule_sets ADD COLUMN card_version VARCHAR(10) NOT NULL DEFAULT 'base'",
            "ALTER TABLE rule_sets ADD COLUMN is_shown BOOLEAN NOT NULL DEFAULT 1",
            "ALTER TABLE section_images ADD COLUMN intended_position VARCHAR(10)",
            "ALTER TABLE sections ADD COLUMN section_status VARCHAR(20) DEFAULT 'normal'",
            "ALTER TABLE sections ADD COLUMN is_done BOOLEAN NOT NULL DEFAULT 0",
            "ALTER TABLE sections ADD COLUMN cost_reset_at DATETIME",
            "ALTER TABLE cards ADD COLUMN manually_added BOOLEAN NOT NULL DEFAULT 0",
            "ALTER TABLE cards ADD COLUMN accuracy_score INTEGER",
            "ALTER TABLE cards ADD COLUMN accuracy_note TEXT",
            "ALTER TABLE cards ADD COLUMN eor_yield TEXT",
            "ALTER TABLE cards ADD COLUMN correctness_score INTEGER",
            "ALTER TABLE cards ADD COLUMN correctness TEXT",
            "ALTER TABLE cards ADD COLUMN validation_change TEXT",
            "ALTER TABLE ai_usage_log ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE ai_usage_log ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0",
            # Curriculum-aligned ingestion: parsed H1-H4 outline stored at upload scan time.
            "ALTER TABLE uploads ADD COLUMN heading_outline JSON",
            # Curriculum-aligned ingestion: resolution map (hid -> node_id) persisted
            # so a retry after a step failure reruns the same pipeline.
            "ALTER TABLE uploads ADD COLUMN resolution_map JSON",
            # Topic color marker (green = added outside the official curriculum).
            "ALTER TABLE curriculum ADD COLUMN color VARCHAR(20)",
            # Frozen faithful source block sent to the AI verbatim (heading + body).
            "ALTER TABLE sections ADD COLUMN content_source TEXT",
            # SBS audit trace — added after sbs_jobs shipped, so existing DBs need it.
            "ALTER TABLE sbs_jobs ADD COLUMN trace JSON",
            # Indexes for the most common filters (no-ops if they already exist)
            "CREATE INDEX IF NOT EXISTS ix_cards_section_id ON cards(section_id)",
            "CREATE INDEX IF NOT EXISTS ix_cards_status ON cards(status)",
            "CREATE INDEX IF NOT EXISTS ix_sections_topic_tree_id ON sections(topic_tree_id)",
            "CREATE INDEX IF NOT EXISTS ix_sections_curriculum_topic_path ON sections(curriculum_topic_path)",
            "CREATE INDEX IF NOT EXISTS ix_content_blocks_section_id ON content_blocks(section_id)",
            "CREATE INDEX IF NOT EXISTS ix_section_images_section_id ON section_images(section_id)",
            "CREATE INDEX IF NOT EXISTS ix_ai_usage_log_job_id ON ai_usage_log(job_id)",
        ]:
            try:
                conn.execute(text(col_sql))
                conn.commit()
            except Exception:
                pass


def _backfill_new_curriculum_surgery():
    """The 'New' (v1) curriculum was missing the Surgery topic that exists in
    'Current' (v2). Surgery is part of the new curriculum too — it just had no
    updates, so it never surfaced as an updated topic. Copy the full Surgery
    subtree from v2 -> v1 if it's absent. Idempotent; copies from whatever DB
    it runs in (so on Railway it pulls that instance's live Current Surgery)."""
    import logging
    from sqlalchemy import func
    from backend.models import Curriculum

    db = SessionLocal()
    try:
        if db.query(Curriculum).filter_by(version="v1", level=0, name="Surgery").first():
            return  # already present
        # Rename-proof guard: if v1 already has at least as many top-level topics
        # as v2, it was fully populated (Surgery included, possibly renamed) —
        # don't re-copy just because the literal name "Surgery" is gone.
        v1_tops = db.query(Curriculum).filter_by(version="v1", level=0).count()
        v2_tops = db.query(Curriculum).filter_by(version="v2", level=0).count()
        if v1_tops >= v2_tops:
            return
        root = db.query(Curriculum).filter_by(version="v2", level=0, name="Surgery").first()
        if not root:
            return  # nothing to copy

        subtree = [root] + (
            db.query(Curriculum)
            .filter(Curriculum.version == "v2", Curriculum.path.like(root.path + " > %"))
            .all()
        )
        subtree.sort(key=lambda c: (c.level, c.sort_order))  # parents before children

        # Append Surgery after the existing v1 top-level topics.
        max_top = db.query(func.max(Curriculum.sort_order)).filter_by(version="v1", level=0).scalar() or 0

        id_map: dict[int, int] = {}  # old v2 id -> new v1 id
        for c in subtree:
            node = Curriculum(
                parent_id=None if c.parent_id is None else id_map[c.parent_id],
                name=c.name,
                level=c.level,
                path=c.path,  # path carries no version component — identical across versions
                sort_order=(max_top + 1) if c.level == 0 else c.sort_order,
                version="v1",
            )
            db.add(node)
            db.flush()
            id_map[c.id] = node.id
        db.commit()
        logging.getLogger(__name__).info(
            "Backfilled Surgery into New (v1) curriculum: %d nodes", len(subtree)
        )
    except Exception:
        db.rollback()
        logging.getLogger(__name__).exception("Surgery backfill into v1 failed")
    finally:
        db.close()


def _sweep_orphaned_jobs():
    """Mark jobs left running/pending by a previous process as failed.

    Background tasks die with the process — any job still 'running' at startup
    can never finish and would show as stuck in the UI forever.
    """
    from backend.models import GenerationJob, ProcessingJob, JobStatus, utcnow
    db = SessionLocal()
    try:
        for model_cls in (GenerationJob, ProcessingJob):
            stuck = db.query(model_cls).filter(
                model_cls.status.in_([JobStatus.pending, JobStatus.running])
            ).all()
            if model_cls is ProcessingJob:
                # Reconcile jobs park as 'running' while waiting on a human —
                # they must survive a restart, not be swept as orphaned.
                stuck = [j for j in stuck if j.pipeline_step != "awaiting_reconcile"]
            for job in stuck:
                job.status = JobStatus.failed
                job.error_message = "Interrupted by server restart"
                job.finished_at = utcnow()
        # Fix batches run as background tasks too — sweep ones orphaned mid-run.
        from backend.models import Card, FixBatch, FixProposal
        stuck_batches = db.query(FixBatch).filter(
            FixBatch.status.in_(["pending", "running"])
        ).all()
        for batch in stuck_batches:
            batch.status = "cancelled"
            batch.error_message = "Interrupted by server restart"
            batch.finished_at = utcnow()
        if stuck_batches:
            # Release in_fix_batch cards. An orphaned batch may have died before
            # writing proposals, so we can't enumerate its cards — instead keep
            # the flag only on cards held by a 'done' batch awaiting confirmation.
            held_ids = {
                cid for (cid,) in db.query(FixProposal.original_card_id)
                .join(FixBatch, FixProposal.batch_id == FixBatch.id)
                .filter(FixBatch.status == "done")
                .all()
            }
            q = db.query(Card).filter(Card.in_fix_batch.is_(True))
            if held_ids:
                q = q.filter(Card.id.notin_(held_ids))
            q.update({"in_fix_batch": False}, synchronize_session=False)
        db.commit()
    except Exception:
        db.rollback()
        import logging
        logging.getLogger(__name__).exception("Orphaned-job sweep failed")
    finally:
        db.close()


def _sweep_old_scans(max_age_hours: int = 6):
    """Delete abandoned ephemeral scan files (temp .docx + sidecar .json) older
    than max_age_hours so previews that were never Continued don't accumulate."""
    import time
    from backend.config import SCAN_DIR
    try:
        if not os.path.isdir(SCAN_DIR):
            return
        cutoff = time.time() - max_age_hours * 3600
        for name in os.listdir(SCAN_DIR):
            path = os.path.join(SCAN_DIR, name)
            try:
                if os.path.isfile(path) and os.path.getmtime(path) < cutoff:
                    os.remove(path)
            except OSError:
                pass
    except Exception:
        import logging
        logging.getLogger(__name__).exception("Scan sweep failed")


@asynccontextmanager
async def lifespan(app: FastAPI):
    os.makedirs(os.path.join(os.path.dirname(__file__), "..", "data", "uploads"), exist_ok=True)
    Base.metadata.create_all(bind=engine)
    _migrate_db()
    seed_data()
    _backfill_new_curriculum_surgery()
    _sweep_orphaned_jobs()
    _sweep_old_scans()
    yield


app = FastAPI(title="EOR Card Studio v4", lifespan=lifespan)


@app.exception_handler(Exception)
async def _unhandled_error_handler(request, exc: Exception):
    """Return the precise failure reason instead of a bare 'Internal Server
    Error'. Private two-user app — surfacing exception details to the UI is a
    feature here, not a leak. Full traceback still goes to the server log."""
    from fastapi.responses import JSONResponse
    import logging
    logging.getLogger(__name__).exception(
        "Unhandled error on %s %s", request.method, request.url.path
    )
    return JSONResponse(
        status_code=500,
        content={"detail": f"{type(exc).__name__}: {exc}"},
    )


@app.middleware("http")
async def _no_store_api(request, call_next):
    """Never let the browser/proxy cache API responses. With two users sharing
    one instance, a cached GET would show stale data (e.g. a card the other user
    just deleted). Forces every /api read to come from the DB."""
    response = await call_next(request)
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate"
    return response


# Bumped on each deploy so /api/version can confirm what's actually running.
APP_VERSION = 94


@app.get("/api/version")
def version():
    """Authoritative, cache-proof check of the running backend.

    `commit` is the exact git SHA Railway deployed (RAILWAY_GIT_COMMIT_SHA),
    so you can compare it to the commit you pushed. `features` flags code that
    must be present for the supplemental fix to be live.
    """
    return {
        "version": APP_VERSION,
        "commit": os.getenv("RAILWAY_GIT_COMMIT_SHA", "local"),
        "features": ["supplemental-tool-output"],
    }


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
app.include_router(presentations.router, prefix="/api/presentations", tags=["presentations"])
app.include_router(sbs.router, prefix="/api/sbs", tags=["sbs"])
app.include_router(verify.router, prefix="/api/verify", tags=["verify"])
app.include_router(lab.router, prefix="/api/lab", tags=["lab"])


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
