import unittest
import numpy as np
from pipeline import blocks

TAGS = [["cat", "pet"], ["cat", "fur"], ["dog", "pet"], ["dog", "fur"], ["sea", "ship"], ["sea", "wave"]] * 10
COLOUR = [{"lightness": 0.5, "contrast": 0.4, "warmth": 0.1, "chroma": 0.05, "hue": "blue", "monochrome": False}] * 3 + [None] * 3

def basis():
    blocks.MIN_USES = 5
    colour_rows = [blocks.colour_raw(c, 1800) for c in COLOUR * 10]
    return blocks.build_basis(TAGS, colour_rows)

class Blocks(unittest.TestCase):
    def test_unit_and_block_shares(self):
        b = basis()
        sem = np.random.default_rng(0).normal(size=(60, blocks.SEM))
        x = blocks.extend(sem, TAGS, [blocks.colour_raw(c, 1800) for c in COLOUR * 10], b)
        self.assertEqual(x.shape, (60, blocks.DIM))
        np.testing.assert_allclose(np.linalg.norm(x, axis=1), 1, atol=1e-6)
        share = [np.sum(x[:, a:z] ** 2, axis=1).mean() for a, z in ((0, 64), (64, 88), (88, 96))]
        np.testing.assert_allclose(share, blocks.WEIGHT, atol=0.02)

    def test_works_sharing_tags_are_closer(self):
        b = basis()
        sem = np.zeros((60, blocks.SEM)); sem[:, 0] = 1
        x = blocks.extend(sem, TAGS, [blocks.colour_raw(None, None)] * 60, b)
        same, other = x[0] @ x[6], x[0] @ x[4]  # cat+pet twice, versus cat+pet and sea+ship
        self.assertGreater(same, other)

    def test_colour_raw_without_features_is_zero_but_for_the_era(self):
        v = blocks.colour_raw(None, 1700)
        self.assertEqual(list(v[:7]), [0] * 7)
        self.assertEqual(v[7], 0)
        self.assertGreater(blocks.colour_raw(None, 1950)[7], 0)

    def test_int8_stays_unit(self):
        x = blocks.to_int8(np.array([[3.0, 4.0]]))
        self.assertEqual(x[0].tolist(), [76, 102])

if __name__ == "__main__":
    unittest.main()
