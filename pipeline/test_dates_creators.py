import unittest
from pipeline import dates, creators

DATES = {
    "": None, "n.d.": None, "2021": (2021, 2021), "c. 1300–1325": (1300, 1325), "1896–97": (1896, 1897),
    "17th century": (1600, 1699), "1890s": (1890, 1899), "ca. 1650": (1650, 1650), "500 BCE": (-500, -500),
    "um 1600 bis 1650": (1600, 1650), "1914-1918": (1914, 1918),
}
CREATORS = {
    "Unknown": None, "Unknown maker": None, "N. N.": None, "Anonym": None, "Desconegut": None, "": None,
    "Smith, Joe (1928-) (Interviewer)": "Joe Smith", "Joe Smith": "Joe Smith",
    "Hall, John (author)": "John Hall", "Thomas Wolf  ,   www.foto-tw.de": "Thomas Wolf",
    "https://d-nb.info/gnd/122027248": None, "#agent_644ba1a8-c9fc-11e3-88f2-a712c83050a3": None,
    "Schumacher, Klaus-Dieter (Herstellung) (Fotograf)": "Klaus-Dieter Schumacher", "Antimenes Painter": "Antimenes Painter",
}

class Dates(unittest.TestCase):
    def test_golden(self):
        for text, want in DATES.items():
            self.assertEqual(dates.parse(text), want, text)

    def test_era(self):
        self.assertEqual([dates.era(s) for s in (None, (1300, 1300), (1650, 1650), (1850, 1850), (1920, 1920), (2010, 2010))], [0, 1, 2, 3, 4, 5])

class Creators(unittest.TestCase):
    def test_golden(self):
        for text, want in CREATORS.items():
            self.assertEqual(creators.normalise(text), want, text)

    def test_key_unifies_order(self):
        self.assertEqual(creators.key("Smith, Joe"), creators.key("Joe Smith"))

if __name__ == "__main__":
    unittest.main()
