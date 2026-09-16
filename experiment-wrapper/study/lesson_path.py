"""
Geometry for the Duolingo-style lesson path on the landing page and dashboard.

The horizontal offsets and 108px vertical step are lifted from the Figma frame
(node centres at x = 874, 912, 990, 971, 1059 for lessons 1-5, y stepping
~108px). Beyond five they wave back rather than drifting off the right edge,
which is what the fixed Figma comp does not have to answer.

Coordinates are emitted bottom-up in a local box, so the template can position
lesson 1 nearest the torii gate at the bottom.
"""

NODE_W = 76
NODE_H = 50
STEP_Y = 108
#: Left gutter so the 127px-wide 'Start' bubble clears the container edge.
BASE_X = 130
X_OFFSETS = [0, 38, 116, 97, 185, 97, 116, 38]
DOTS_BETWEEN = 3


def build_path(lessons, current_lesson_id=None, statuses=None):
    """
    `lessons` is ordered by number (lesson 1 first). Returns nodes bottom-up
    plus the connector dots, in a box whose height depends on lesson count.
    """
    statuses = statuses or {}
    count = max(len(lessons), 1)
    height = STEP_Y * count + NODE_H + 40

    nodes = []
    for i, lesson in enumerate(lessons):
        x = BASE_X + X_OFFSETS[i % len(X_OFFSETS)]
        y = height - NODE_H - 40 - (i * STEP_Y)
        status = statuses.get(lesson.id, "locked")
        nodes.append(
            {
                "lesson": lesson,
                "x": x,
                "y": y,
                "cx": x + NODE_W / 2,
                "cy": y + NODE_H / 2,
                "status": status,
                "is_current": lesson.id == current_lesson_id,
                "unlocked": status in ("available", "in_progress", "unfinished", "completed"),
            }
        )

    dots = []
    for lower, upper in zip(nodes, nodes[1:]):
        for k in range(1, DOTS_BETWEEN + 1):
            t = k / (DOTS_BETWEEN + 1)
            dots.append(
                {
                    "x": lower["cx"] + (upper["cx"] - lower["cx"]) * t - 5.5,
                    "y": lower["cy"] + (upper["cy"] - lower["cy"]) * t - 5.5,
                    "active": upper["unlocked"],
                }
            )

    # Figma places the torii 60px left of and 99px below lesson 1, behind the
    # path art.
    first = nodes[0] if nodes else {"x": BASE_X, "y": height - NODE_H - 40}
    return {
        "nodes": nodes,
        "dots": dots,
        "height": height + 120,
        "width": 620,
        "torii_x": first["x"] - 60,
        "torii_y": first["y"] + 99,
    }
