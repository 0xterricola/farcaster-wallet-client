import unittest
from unittest import mock

from console import herdr_action


class HerdrActionTests(unittest.TestCase):
    @mock.patch("console.herdr_action.subprocess.run")
    def test_button_opens_the_real_plugin_pane_with_action_context(self, run):
        run.return_value.returncode = 0
        result = herdr_action.open_pane("status", herdr_bin="/opt/herdr", plugin_id="fun.fiddy.console")
        self.assertEqual(result, 0)
        argv = run.call_args_list[0].args[0]
        self.assertEqual(argv[:3], ["/opt/herdr", "plugin", "pane"])
        self.assertIn("fun.fiddy.console", argv)
        self.assertIn("FIDDY_CONSOLE_ACTION=status", argv)
        self.assertIn("--focus", argv)

    def test_unknown_button_is_rejected_before_execution(self):
        with self.assertRaises(ValueError):
            herdr_action.open_pane("rm-rf")

    @mock.patch("console.herdr_action.subprocess.run")
    def test_opened_tab_gets_a_real_name(self, run):
        run.return_value.returncode = 0
        run.return_value.stdout = '{"result":{"panes":[{"pane_id":"w1:p9","tab_id":"w1:t9","focused":true}]}}'
        herdr_action.open_pane("status", herdr_bin="/opt/herdr")
        rename = run.call_args_list[-1].args[0]
        self.assertEqual(rename, ["/opt/herdr", "tab", "rename", "w1:t9", "Node Status"])


if __name__ == "__main__":
    unittest.main()
