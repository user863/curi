import unittest
from pipeline import quality_v2 as q

class Rescore(unittest.TestCase):
    def test_ranks_inside_each_source(self):
        works = [{"id": i, "source": "a", "type": "image", "quality": 1.4} for i in range(3)] + \
                [{"id": 10, "source": "b", "type": "image", "quality": 1.1}]
        out = q.rescore(works, {}, {})
        self.assertEqual(out[0], out[1])               # ties share a rank
        self.assertAlmostEqual(out[10], 1.2)           # alone in its group: the middle
        self.assertTrue(all(1.0 <= v <= 1.4 for v in out.values()))

    def test_signals(self):
        w = [{"id": 1, "source": "a", "type": "image", "quality": 1.3}, {"id": 2, "source": "a", "type": "image", "quality": 1.3}]
        soft = {"longSide": 1500, "bytesPerPixel": 1.5, "sharp": 100}   # weak enough for the document and flat penalties
        out = q.rescore(w, {1: ["featured-picture"], 2: ["document"]}, {}, {1: soft, 2: soft})
        self.assertGreater(out[1], out[2])
        flat = {"contrast": 0.1, "lightness": 0.5}
        out = q.rescore(w, {}, {2: flat}, {1: soft, 2: soft})
        self.assertGreater(out[1], out[2])

    def test_crisp_files_are_not_judged_flat_blank_or_document(self):
        crisp = {"longSide": 1500, "bytesPerPixel": 1.5, "sharp": 600}  # studio photo on white, line art
        self.assertEqual(q.penalties(["document"], {"contrast": 0.1, "lightness": 0.97}, crisp), {})
        self.assertEqual(q.penalties(["document"], {"contrast": 0.1, "lightness": 0.97}, None), {})
        self.assertEqual(set(q.penalties(["document"], {"contrast": 0.1, "lightness": 0.97}, {**crisp, "sharp": 100})), {"document", "flat", "blank"})

if __name__ == "__main__":
    unittest.main()

class Technical(unittest.TestCase):
    def test_weak_files_lose_rank_and_missing_statistics_change_nothing(self):
        good = {"longSide": 1500, "bytesPerPixel": 1.5, "sharp": 400}
        weak = {"longSide": 300, "bytesPerPixel": 0.2, "sharp": 3}
        self.assertEqual(q.technical(None), 0)
        self.assertEqual(q.technical(good), 0)
        self.assertAlmostEqual(q.technical(weak), 0.2 + 0.1 + 0.15)
        works = [{"id": 1, "source": "a", "type": "image", "quality": 1.2}, {"id": 2, "source": "a", "type": "image", "quality": 1.2}]
        out = q.rescore(works, {}, {}, {1: good, 2: weak})
        self.assertGreater(out[1], out[2])
