import unittest
from . import keywords


class Keywords(unittest.TestCase):
    def test_best_rated_tags_first_and_buckets_and_eras_left_out(self):
        rows = [{"id": i, "quality": 200 if i < 60 else 100} for i in range(1000)]
        tags = {i: ["ukiyo-e"] if i < 60 else ["painting", "19th-century", "new"] for i in range(1000)}
        tags[100] = ["rare"]  # one work: under the floor
        self.assertEqual(keywords.pick(rows, tags, floor=40, ceiling=0.1, known=lambda s: s in ("ukiyo-e", "painting")), ["ukiyo-e"])


if __name__ == "__main__":
    unittest.main()
