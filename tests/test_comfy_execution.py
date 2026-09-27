"""Integration check using the installed ComfyUI execution module (see comfy_execution_probe.py)."""

import importlib.util
import pathlib
import subprocess
import sys
import unittest


class TestComfyExecution(unittest.TestCase):
    """Run the probe in a subprocess so ComfyUI's `nodes` never meets this repo's `nodes`."""

    def test_real_v3_execution_and_per_pair_blockers(self) -> None:
        """Real execution: 3 main outputs, 12 helper outputs, empty pairs blocked silently."""
        source = importlib.util.find_spec("execution")
        if source is None or source.origin is None:
            self.skipTest("ComfyUI is not on PYTHONPATH")
        probe = pathlib.Path(__file__).with_name("comfy_execution_probe.py")
        result = subprocess.run([sys.executable, str(probe)],
                                cwd=pathlib.Path(source.origin).parent,
                                capture_output=True, text=True, timeout=120)
        skips = [line for line in result.stdout.splitlines() if line.startswith("SKIP:")]
        if result.returncode == 0 and skips:
            self.skipTest(skips[-1])
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("per-pair blockers passed", result.stdout)


if __name__ == "__main__":
    unittest.main()
