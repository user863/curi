import unittest
from . import daily


def row(i, quality, **kw):
    return {"id": i, "type": "image", "source": "eu", "title": f"t{i}", "creator": f"c{i}", "swatch": "#aabbcc", "quality": quality, **kw}


class Daily(unittest.TestCase):
    def test_best_first_and_only_pictures_a_widget_can_load(self):
        rows = [row(1, 10), row(2, 90), row(3, 80, type="video"), row(4, 70, swatch=None), row(5, 60), row(6, 95)]
        media = {i: {"url": f"https://x.test/{i}.jpg"} for i in range(1, 7)}
        media[6] = {"url": "https://www.artic.edu/iiif/2/6/full/843,/0/default.jpg"}
        got = daily.pick(rows, media, count=3, per_source=1.0)
        self.assertEqual(sorted(p["id"] for p in got), [1, 2, 5])

    def test_one_creator_twice_at_most(self):
        rows = [row(i, 100 - i, creator="Same") for i in range(6)]
        media = {i: {"url": f"https://x.test/{i}.jpg"} for i in range(6)}
        self.assertEqual(len(daily.pick(rows, media, count=5, per_source=1.0)), 2)


if __name__ == "__main__":
    unittest.main()
