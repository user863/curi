import unittest
from pipeline.starter import starter

def work(i, **kw):
    return {"id": i, "cluster": 1, "type": "image", "room": "landscapes", "quality": 1.2, "source": "a", "creator": f"c{i}", **kw}

class Starter(unittest.TestCase):
    def test_skips_mono_and_repeated_creators(self):
        rows = [work(1, quality=1.4), work(2, quality=1.39, creator="c1"), work(3, quality=1.3), work(4, quality=1.38)]
        out = starter(rows, mono_ids={4})
        ids = [i for i, _ in out]
        self.assertIn(1, ids)
        self.assertNotIn(2, ids)   # same creator as 1
        self.assertNotIn(4, ids)   # monochrome

    def test_source_cap(self):
        rows = [work(i, room=r) for i, r in enumerate(["landscapes", "paintings", "people", "cities", "wildlife", "objects"])]
        self.assertLessEqual(len(starter(rows, set())), 4)

if __name__ == "__main__":
    unittest.main()
