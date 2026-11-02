import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("cpu_gate", Path(__file__).with_name("macos-cpu-check.py"))
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


class CpuGateTests(unittest.TestCase):
    def test_cumulative_cpu_formats(self):
        for text, seconds in [("0:01.25", 1.25), ("10:12.00", 612), ("01:02:03", 3723), ("2-01:02:03", 176523)]:
            self.assertEqual(gate.cpu_seconds(text), seconds)

    def test_one_core_is_one_hundred_percent(self):
        self.assertEqual(gate.cpu_percent(100, 130, 30), 100)
        self.assertEqual(gate.cpu_percent(100, 101.5, 30), 5)
        self.assertGreater(gate.cpu_percent(100, 131, 30), 100)

    def test_restarted_process_or_invalid_window_cannot_pass(self):
        for values in [(10, 1, 30), (1, 2, 0), (1, 2, -1)]:
            with self.assertRaises(ValueError):
                gate.cpu_percent(*values)


if __name__ == "__main__":
    unittest.main()
