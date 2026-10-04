"""Inline weeks.json into template.html: python3 tools/viewer/build.py weeks.json OUT.html"""
import json
import sys
from pathlib import Path

weeks = json.loads(Path(sys.argv[1]).read_text())
data = json.dumps(weeks, separators=(",", ":")).replace("</", "<\\/")
tpl = (Path(__file__).parent / "template.html").read_text()
Path(sys.argv[2]).write_text(tpl.replace("__DATA__", data))
print(len(weeks), "weeks,", Path(sys.argv[2]).stat().st_size // 1024, "KB")
