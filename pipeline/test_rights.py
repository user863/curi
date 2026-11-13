import unittest
from pipeline import rights

class Admitted(unittest.TestCase):
    def test_commercial_licences_only(self):
        ok = lambda lic, **k: rights.admitted({"license": lic, "gate": "yes", "attribution": "A by B", **k})
        for lic in ("CC0", "PDM", "CC-BY", "CC-BY-SA", "LOC-FREE", "LOC-ATTR"):
            self.assertTrue(ok(lic), lic)
        for lic in ("CC-BY-NC", None, "ALL-RIGHTS"):
            self.assertFalse(ok(lic), lic)

    def test_gate_and_attribution_line(self):
        self.assertFalse(rights.admitted({"license": "CC0", "gate": "unknown", "attribution": ""}))
        self.assertFalse(rights.admitted({"license": "CC-BY", "gate": "yes", "attribution": " "}))
        self.assertTrue(rights.admitted({"license": "CC0", "gate": "yes", "attribution": ""}))

    def test_nasa_public_domain(self):
        r = rights.rights("NASA-PD", "worldwide", "NASA", "image")
        self.assertTrue(rights.admitted(r))
        self.assertEqual(r["derivativesOk"], "yes")

if __name__ == "__main__":
    unittest.main()
