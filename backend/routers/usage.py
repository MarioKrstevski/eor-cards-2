from fastapi import APIRouter, Depends
from sqlalchemy import func
from sqlalchemy.orm import Session
from backend.db import get_db
from backend.models import AIUsageLog

router = APIRouter()


@router.get("/summary")
def get_usage_summary(db: Session = Depends(get_db)):
    rows = db.query(
        AIUsageLog.operation,
        func.sum(AIUsageLog.cost_usd).label("cost_usd"),
        func.sum(AIUsageLog.input_tokens).label("input_tokens"),
        func.sum(AIUsageLog.output_tokens).label("output_tokens"),
        func.count(AIUsageLog.id).label("count"),
    ).group_by(AIUsageLog.operation).all()

    by_operation = {
        r.operation: {
            "cost_usd": round(r.cost_usd or 0, 6),
            "input_tokens": r.input_tokens or 0,
            "output_tokens": r.output_tokens or 0,
            "count": r.count,
        }
        for r in rows
    }
    total = round(sum(r["cost_usd"] for r in by_operation.values()), 6)
    return {"total_cost_usd": total, "by_operation": by_operation}
