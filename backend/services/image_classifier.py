"""Classify images using Claude Vision and extract text when needed."""
from __future__ import annotations
import logging
import anthropic

logger = logging.getLogger(__name__)


def classify_image(
    client: anthropic.Anthropic,
    data_uri: str,
    alt_text_hint: str | None = None,
    model: str = "claude-haiku-4-5-20251001",
) -> dict:
    """Classify an image and optionally extract text using Claude Vision.

    Args:
        client: Anthropic client
        data_uri: Base64 data URI of the image
        alt_text_hint: Alt text hint (e.g., "EXTRACT", "REFERENCE")
        model: Model to use for classification

    Returns:
        {
            "category": "decorative" | "diagram" | "chart" | "table_image" | "unclear",
            "extracted_text": str | None,
            "usage": {"input_tokens": int, "output_tokens": int}
        }
    """
    # Parse the data URI
    if not data_uri.startswith("data:"):
        return {"category": "unclear", "extracted_text": None, "usage": {"input_tokens": 0, "output_tokens": 0}}

    # Extract media type and base64 data
    header, b64_data = data_uri.split(",", 1)
    media_type = header.split(";")[0].replace("data:", "")

    prompt = """Analyze this image and classify it into one of these categories:
- decorative: logos, borders, purely decorative elements
- diagram: anatomical diagrams, flowcharts, process diagrams
- chart: graphs, bar charts, pie charts, data visualizations
- table_image: images of tables with data
- unclear: cannot determine

Also, if the image contains readable text or data, extract it verbatim.

Output format:
CATEGORY: <category>
EXTRACTED_TEXT: <text or NONE>"""

    if alt_text_hint:
        prompt += f"\n\nHint from document: {alt_text_hint}"

    try:
        response = client.messages.create(
            model=model,
            max_tokens=1024,
            temperature=0,
            messages=[{
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": media_type,
                            "data": b64_data,
                        },
                    },
                    {"type": "text", "text": prompt},
                ],
            }],
        )

        raw = response.content[0].text.strip()
        usage = {
            "input_tokens": response.usage.input_tokens,
            "output_tokens": response.usage.output_tokens,
        }

        # Parse output
        category = "unclear"
        extracted_text = None

        for line in raw.split("\n"):
            line = line.strip()
            if line.startswith("CATEGORY:"):
                cat = line.split(":", 1)[1].strip().lower()
                if cat in ("decorative", "diagram", "chart", "table_image", "unclear"):
                    category = cat
            elif line.startswith("EXTRACTED_TEXT:"):
                text = line.split(":", 1)[1].strip()
                if text.upper() != "NONE":
                    extracted_text = text

        # If there's multi-line extracted text after EXTRACTED_TEXT:
        if "EXTRACTED_TEXT:" in raw:
            text_part = raw.split("EXTRACTED_TEXT:", 1)[1].strip()
            if text_part.upper() != "NONE" and len(text_part) > 5:
                extracted_text = text_part

        return {"category": category, "extracted_text": extracted_text, "usage": usage}

    except Exception as e:
        logger.exception("Image classification failed")
        return {
            "category": "unclear",
            "extracted_text": None,
            "usage": {"input_tokens": 0, "output_tokens": 0},
        }
