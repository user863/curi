import unittest
from . import colour_pack


class HueColumn(unittest.TestCase):
    def test_six_bytes_per_work_and_zero_without_colour(self):
        f = {"palette": [{"weight": 0.5, "lab": [0.66, 0.18, -0.02]}, {"weight": 0.3, "lab": [0.85, 0.0, 0.0]}]}
        col = colour_pack.hue_column({3: f}, 4)
        self.assertEqual(len(col), 30)
        self.assertEqual(col[:18], bytes(18))
        self.assertEqual(col[18], round(0.66 * 255))
        self.assertEqual(col[18:21], col[21:24])  # the dominant colour is also the most colourful one here

    def test_accent_is_the_most_colourful_of_the_top_three(self):
        f = {"palette": [{"weight": 0.6, "lab": [0.8, 0.0, 0.0]}, {"weight": 0.3, "lab": [0.5, 0.2, 0.1]}]}
        col = colour_pack.hue_column({0: f}, 0)
        self.assertEqual(col[0], round(0.8 * 255))
        self.assertEqual(col[3], round(0.5 * 255))


if __name__ == "__main__":
    unittest.main()
