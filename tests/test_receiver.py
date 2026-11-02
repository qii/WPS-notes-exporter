"""Run: python3 -B -m unittest discover -s tests -p 'test_*.py'."""
import contextlib
import io
import json
from pathlib import Path
import runpy
import tempfile
import unittest
from unittest.mock import patch


class ReceiverTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        # Import without creating the real export directory.
        with patch("os.makedirs"):
            module = runpy.run_path(str(Path(__file__).resolve().parents[1] / "local_receiver.py"))
        self.handler_class = module["ReceiverHandler"]
        self.handler_class.do_POST.__globals__["SAVE_DIR"] = str(self.root)

    def request(self, method, path, payload=None):
        body = json.dumps(payload).encode("utf-8") if payload is not None else b""
        handler = object.__new__(self.handler_class)
        handler.path = path
        handler.headers = {"Content-Length": str(len(body))}
        handler.rfile = io.BytesIO(body)
        handler.wfile = io.BytesIO()
        statuses = []
        handler.send_response = statuses.append
        handler.send_header = lambda *args: None
        handler.end_headers = lambda: None
        with contextlib.redirect_stdout(io.StringIO()):
            getattr(handler, "do_" + method)()
        return statuses[0], json.loads(handler.wfile.getvalue())

    def test_health_does_not_modify_existing_exports(self):
        existing = self.root / "existing.md"
        existing.write_text("existing note", encoding="utf-8")
        status, data = self.request("GET", "/health")
        self.assertEqual(status, 200)
        self.assertEqual(data["service"], "wps-notes-exporter")
        self.assertEqual(list(self.root.iterdir()), [existing])
        self.assertEqual(existing.read_text(), "existing note")

    def test_save_acknowledges_files_and_preserves_duplicates(self):
        payload = {"clean": False, "notes": [
            {"group": "工作", "title": "记录", "content": "# 标题\n\n正文", "createTime": "2022-05-03"},
            {"group": "工作", "title": "记录", "content": "另一条"},
        ]}
        status, data = self.request("POST", "/save", payload)
        self.assertEqual(status, 200)
        self.assertEqual(data, {"status": "success", "count": 2})
        self.assertEqual((self.root / "工作/记录.md").read_text(), "【2022.5.3 created】\n\n正文\n")
        self.assertEqual((self.root / "工作/记录_1.md").read_text(), "【创建时间未知 created】\n\n另一条\n")


if __name__ == "__main__":
    unittest.main()
