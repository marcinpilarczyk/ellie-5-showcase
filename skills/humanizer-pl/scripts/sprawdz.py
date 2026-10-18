#!/usr/bin/env python3
"""Skaner polskiego tekstu dla skilla humanizer-pl.

Użycie:
    python3 sprawdz.py plik.txt [--fikcja] [--druk]
    echo "tekst" | python3 sprawdz.py -

Poziomy:
    BŁĄD     - łamie normę albo regułę skilla; popraw.
    SPRAWDŹ  - wzorzec podejrzany; oceń w kontekście.

Kod wyjścia: 1, jeśli są błędy; 0 w przeciwnym razie.
Skaner nie zastępuje lektury: zna wzorce, nie zna kontekstu.
"""
import re
import sys
import unicodedata

AI_SLOWA = [
    r"kluczow\w*", r"fundamentaln\w*", r"przełomow\w*", r"wszechstronn\w*",
    r"holistyczn\w*", r"innowacyjn\w*", r"nieoceniony\w*", r"fascynując\w*",
    r"imponując\w*", r"stanowi\w*", r"podkreśla\w*", r"odzwierciedla\w*",
    r"przyczynia\w* się do", r"odgrywa\w* \w*\s?rolę", r"warto (?:zauważyć|podkreślić)",
    r"należy (?:zauważyć|pamiętać|podkreślić)", r"w kontekście", r"w dobie",
    r"w erze", r"w obliczu", r"realnie", r"dedykowan\w*", r"niezwykle",
    r"na przestrzeni lat", r"idzie w parze", r"nie sposób nie zauważyć",
    r"dynamicznie zmieniając\w* się świe\w*", r"charakteryzuje się",
    r"może (?:się )?poszczycić", r"jawi się jako", r"wpisuje się w",
    r"kamie\w* milow\w*", r"punkt\w* zwrotn\w*", r"tętni\w* życiem",
    r"zapierając\w* dech", r"malownicz\w*", r"w sercu",
]

ARTEFAKTY_CZATU = [
    r"mam nadzieję, że (?:to )?pomo\w*", r"świetne pytanie", r"masz (?:całkowitą |absolutną )?rację",
    r"czy chciał\w*by\w*, (?:żebym|abym)", r"chcesz, (?:żebym|abym)", r"mam kontynuować",
    r"daj znać, jeśli chciał\w*", r"zanurzmy się", r"przyjrzyjmy się bliżej",
    r"rozłóżmy to na czynniki", r"oto, co musisz wiedzieć", r"bez zbędnych ceregieli",
    r"według mojej (?:ostatniej )?(?:aktualizacji|wiedzy)", r"podsumowując,",
    r"prawdziwe pytanie brzmi", r"powiedzmy sobie szczerze", r"^\s*szczerze\?",
]

KALKI = {
    r"odnośnie (?!do\b)": "„odnośnie” bez „do” to błąd: co do, w sprawie, jeśli chodzi o",
    r"w oparciu o": "domyślnie: na podstawie",
    r"w każdym bądź razie": "w każdym razie",
    r"póki co": "na razie, tymczasem",
    r"adresowa\w* (?:problem|kwesti|wyzwani)\w*": "zająć się, rozwiązać",
    r"dostarcza\w* wartoś\w*": "dawać coś konkretnego",
    r"implementacj\w*|implementowa\w*": "wdrożenie, wdrożyć",
    r"na koniec dnia": "ostatecznie, w sumie",
    r"to ma sens": "to rozsądne",
    r"na tej samej stronie": "mieć tę samą wiedzę, zgadzać się",
    r"tylko i wyłącznie": "tylko",
    r"w dniu dzisiejszym": "dziś",
    r"w chwili obecnej": "teraz, obecnie",
    r"celem \w+enia": "żeby + bezokolicznik",
    r"z uwagi na fakt,? że": "bo, ponieważ",
    r"posiada możliwość": "może",
    r"wychodz\w* naprzeciw": "wytnij zdanie",
}

BLEDY_FORM = {
    r"\bposzłem\b": "poszedłem", r"\bwziąść\b": "wziąć", r"\bwłanczać\b": "włączać",
    r"\bprzekonywując\w*": "przekonując-", r"\bokres czasu\b": "pleonazm: okres",
    r"\bcofać się do tyłu\b": "pleonazm", r"\bkontynuować dalej\b": "pleonazm",
    r"\bpotencjalne możliwości\b": "pleonazm", r"\bw miesiącu \w+u\b": "pleonazm: w maju",
    r"\bw/g\b": "wg", r"\bd/s\b": "ds.", r"\bciężki orzech\b": "twardy orzech",
    r"\bodgrywa\w* znaczenie\b": "odgrywać rolę / mieć znaczenie",
    r"\bbrać na uwagę\b": "brać pod uwagę",
}

SPOJNIKI_PODRZEDNE = (
    r"że|żeby|aby|bo|gdy|gdyby|jeśli|jeżeli|ponieważ|choć|chociaż|który|która|które|"
    r"którego|której|którym|którą|których|którymi|kiedy|dlaczego|czy"
)
PRZYIMKI = r"z|ze|w|we|na|do|o|od|po|przy|dla|przez|za|u|nad|pod|przed|między|bez"
# wyrazy, po których brak przecinka przed spójnikiem jest poprawny (zestawienia, spójniki, partykuły)
BEZ_PRZECINKA = {
    "mimo", "chyba", "dlatego", "zwłaszcza", "bardziej", "podczas", "warunkiem", "tak", "to",
    "i", "a", "oraz", "lub", "albo", "ale", "lecz", "czy", "niż", "jak", "nawet", "tylko",
    "właśnie", "zanim", "aż", "tyle", "potem", "wtedy", "dopiero", "jedynie", "zwłaszcza",
    "szczególnie", "jakby", "niby", "ani", "bądź", "przy", "razie", "przypadku", "skoro",
    "chociaż", "choć", "że", "żeby", "aby", "bo", "gdy", "jeśli", "jeżeli",
}

EMOJI_RE = re.compile(
    "[\U0001F300-\U0001FAFF\U00002600-\U000027BF\U0001F000-\U0001F2FF\U00002B00-\U00002BFF]"
)


def rozpoznaj(args):
    fikcja = "--fikcja" in args
    druk = "--druk" in args
    pliki = [a for a in args if not a.startswith("--")]
    if not pliki or pliki[0] == "-":
        return sys.stdin.read(), fikcja, druk
    with open(pliki[0], encoding="utf-8") as f:
        return f.read(), fikcja, druk


def skanuj(tekst, fikcja=False, druk=False):
    wyniki = []

    def dodaj(nr, kol, poziom, kategoria, fragment, rada=""):
        wyniki.append((nr, kol, poziom, kategoria, fragment.strip(), rada))

    w_bloku_kodu = False
    for nr, linia in enumerate(tekst.splitlines(), 1):
        if linia.strip().startswith("```"):
            w_bloku_kodu = not w_bloku_kodu
            continue
        if w_bloku_kodu:
            continue
        # kod w backtickach pomijamy
        robocza = re.sub(r"`[^`]*`", lambda m: "§" * len(m.group()), linia)
        niska = robocza.lower()

        # --- kreski ---
        for m in re.finditer("—", robocza):
            dialog = fikcja and robocza.lstrip().startswith("—")
            if dialog:
                continue
            dodaj(nr, m.start() + 1, "BŁĄD", "pauza —",
                  robocza[max(0, m.start() - 20): m.end() + 20],
                  "kropka, przecinek, dwukropek, nawias albo przebudowa")
        for m in re.finditer(r"(?<=[\w.,;:!?)”»…]) - (?=\S)", robocza):
            dodaj(nr, m.start() + 2, "BŁĄD", "łącznik ze spacjami jako myślnik",
                  robocza[max(0, m.start() - 20): m.end() + 20],
                  "zastąp interpunkcją; w zakresie użyj – bez spacji")
        for m in re.finditer(r"(?<=[\w.,;:!?)”»…]) -- (?=\S)", robocza):
            dodaj(nr, m.start() + 2, "BŁĄD", "podwójny łącznik jako myślnik",
                  robocza[max(0, m.start() - 20): m.end() + 20])
        for m in re.finditer(r"(\S)( ?)–( ?)(\S)", robocza):
            spacje = m.group(2) or m.group(3)
            cyfry = m.group(1).isdigit() and m.group(4).isdigit()
            if cyfry and spacje:
                dodaj(nr, m.start() + 2, "BŁĄD", "zakres liczbowy ze spacjami",
                      m.group(), "zakres półpauzą bez spacji: 2024–2026")
            elif spacje:
                dodaj(nr, m.start() + 2, "SPRAWDŹ", "półpauza ze spacjami",
                      robocza[max(0, m.start() - 20): m.end() + 20],
                      "dozwolona tylko między członami wielowyrazowymi relacji; nie jako pauza")
        for m in re.finditer(r"\d-\d", robocza):
            if not re.search(r"\d{3}-\d{3}|\d{2}-\d{3}", robocza[max(0, m.start() - 3): m.end() + 3]):
                dodaj(nr, m.start() + 2, "SPRAWDŹ", "łącznik w zakresie liczb",
                      m.group(), "zakres: półpauza 10–20 (nie dotyczy kodów i numerów telefonu)")

        # --- cudzysłów ---
        if '"' in robocza:
            dodaj(nr, robocza.index('"') + 1, "BŁĄD", "prosty cudzysłów", robocza.strip()[:60], "„…”")
        if "“" in robocza:
            dodaj(nr, robocza.index("“") + 1, "BŁĄD", "angielski cudzysłów “ ”",
                  robocza.strip()[:60], "polski: „…”")
        otw, zam = robocza.count("„"), robocza.count("”")
        if otw != zam and not ("“" in robocza or '"' in robocza):
            dodaj(nr, 1, "SPRAWDŹ", "niesparowany cudzysłów", robocza.strip()[:60],
                  f"„ ×{otw}, ” ×{zam} (cytat może przechodzić do kolejnej linii)")

        # --- nagłówki: Title Case ---
        h = re.match(r"^\s*#{1,6}\s+(.*)$", robocza)
        if h:
            slowa = re.findall(r"[^\W\d_][\w-]*", h.group(1))
            wielkie = [s for s in slowa[1:] if s[0].isupper() and not s.isupper() and len(s) > 2]
            if len(slowa) > 2 and len(wielkie) >= 2 and len(wielkie) >= (len(slowa) - 1) / 2:
                dodaj(nr, 1, "BŁĄD", "Title Case w nagłówku", h.group(1),
                      "wielką literą tylko pierwszy wyraz i nazwy własne")
        for m in re.finditer(r"#[A-ZĄĆĘŁŃÓŚŹŻ]?[a-ząćęłńóśźż]+(?:[A-ZĄĆĘŁŃÓŚŹŻ][a-ząćęłńóśźż]+){2,}", robocza):
            dodaj(nr, m.start() + 1, "SPRAWDŹ", "hasztag CamelCase", m.group())

        # --- emoji ---
        em = EMOJI_RE.findall(robocza)
        if em:
            dodaj(nr, 1, "SPRAWDŹ", f"emoji ×{len(em)}", robocza.strip()[:60],
                  "dokumenty: zero; LinkedIn: najwyżej jedno na końcu")
            if re.match(r"^\s*(?:[-*]\s*)?" + EMOJI_RE.pattern, robocza):
                dodaj(nr, 1, "BŁĄD", "emoji jako ozdoba nagłówka lub punktu", robocza.strip()[:60])

        # --- typografia ---
        for m in re.finditer(r"(?<=\S) +([,.;:!?])(?!\S*[/\\])", robocza):
            nastepny = robocza[m.end():m.end() + 1]
            if m.group(1) in ".:" and nastepny.isalnum():
                continue
            if m.group(1) in ":;" and nastepny in ")(PDp":  # emotikon
                continue
            dodaj(nr, m.start() + 1, "BŁĄD", "spacja przed znakiem interpunkcyjnym",
                  robocza[max(0, m.start() - 15): m.end() + 5])
        for m in re.finditer(r"(?<=\S)  +(?=\S)", robocza):
            dodaj(nr, m.start() + 1, "BŁĄD", "podwójna spacja", robocza[max(0, m.start() - 15): m.end() + 15])
        for m in re.finditer(r"\d\s%", robocza):
            dodaj(nr, m.start() + 1, "BŁĄD", "spacja przed %", m.group(), "40%")
        if "..." in robocza:
            dodaj(nr, robocza.index("...") + 1, "SPRAWDŹ", "trzy kropki", "...", "wielokropek …")
        if druk:
            for m in re.finditer(r"(?<![\w])([aiouwzAIOUWZ]) +$", robocza + " "):
                dodaj(nr, m.start() + 1, "SPRAWDŹ", "wiszący jednoliterowy wyraz",
                      robocza[-25:], "twarda spacja")

        # --- formy błędne i kalki ---
        for wzor, rada in BLEDY_FORM.items():
            for m in re.finditer(wzor, niska):
                dodaj(nr, m.start() + 1, "BŁĄD", "forma niepoprawna lub pleonazm",
                      robocza[m.start(): m.end()], rada)
        for wzor, rada in KALKI.items():
            for m in re.finditer(wzor, niska):
                dodaj(nr, m.start() + 1, "SPRAWDŹ", "kalka / urzędowszczyzna",
                      robocza[m.start(): m.end()], rada)

        # --- artefakty czatu ---
        for wzor in ARTEFAKTY_CZATU:
            for m in re.finditer(wzor, niska):
                dodaj(nr, m.start() + 1, "BŁĄD", "artefakt czatu / metakomentarz",
                      robocza[m.start(): m.end()])

        # --- przecinek przed spójnikiem podrzędnym ---
        wzor = re.compile(
            r"([\wąćęłńóśźż]+)\s+(?:(?:" + PRZYIMKI + r")\s+)?(" + SPOJNIKI_PODRZEDNE + r")\b",
            re.IGNORECASE,
        )
        for m in wzor.finditer(robocza):
            poprzedni = m.group(1).lower()
            if poprzedni in BEZ_PRZECINKA or poprzedni in PRZYIMKI.split("|"):
                continue
            if m.group(2).lower() == "czy" and not re.search(r"\b(wiem|wiadomo|pyta\w*|sprawdz\w*|zastanaw\w*|ciekaw\w*)$", poprzedni):
                continue
            dodaj(nr, m.start(2) + 1, "SPRAWDŹ", "brak przecinka przed zdaniem podrzędnym?",
                  robocza[max(0, m.start(1) - 10): m.end() + 10])

    # --- słownictwo AI: liczone per akapit ---
    akapity = re.split(r"\n\s*\n", tekst)
    pozycja = 1
    for akapit in akapity:
        niski = akapit.lower()
        trafienia = []
        for wzor in AI_SLOWA:
            trafienia += [m.group() for m in re.finditer(r"\b" + wzor, niski)]
        if len(trafienia) >= 3:
            dodaj(pozycja, 1, "SPRAWDŹ", f"skupisko słownictwa AI ×{len(trafienia)}",
                  ", ".join(sorted(set(trafienia)))[:120], "przepisz akapit konkretem")
        elif trafienia:
            dodaj(pozycja, 1, "SPRAWDŹ", "słownictwo AI", ", ".join(sorted(set(trafienia))))
        if len(re.findall(r"(?:^|[.!?]\s+)bez\s", niski)) >= 3:
            dodaj(pozycja, 1, "BŁĄD", "seria „Bez… Bez… Bez…”", akapit.strip()[:60])
        if re.search(r"\bnie tylko\b.{0,80}\b(?:ale|lecz|to)\b", niski) or re.search(r"\bto nie tylko\b", niski):
            dodaj(pozycja, 1, "SPRAWDŹ", "paralelizm „nie tylko…, ale…”", akapit.strip()[:60])
        if len(re.findall(r"\w+ąc\b", niski)) >= 3:
            dodaj(pozycja, 1, "SPRAWDŹ", "doczepki na -ąc ×" + str(len(re.findall(r"\w+ąc\b", niski))),
                  akapit.strip()[:60])
        pozycja += akapit.count("\n") + 2

    return sorted(wyniki, key=lambda w: (w[0], w[1]))


def main():
    tekst, fikcja, druk = rozpoznaj(sys.argv[1:])
    tekst = unicodedata.normalize("NFC", tekst)
    wyniki = skanuj(tekst, fikcja, druk)
    bledy = sum(1 for w in wyniki if w[2] == "BŁĄD")
    for nr, kol, poziom, kat, frag, rada in wyniki:
        linia = f"{nr}:{kol}  {poziom:8} {kat}: {frag}"
        if rada:
            linia += f"  →  {rada}"
        print(linia)
    print(f"\nBłędy: {bledy}, do sprawdzenia: {len(wyniki) - bledy}")
    sys.exit(1 if bledy else 0)


if __name__ == "__main__":
    main()
