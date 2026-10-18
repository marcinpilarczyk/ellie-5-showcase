---
name: humanizer-pl
description: Pisanie i redakcja tekstów po polsku w imieniu właściciela (owner), poprawnie i bez znamion AI. Łączy normę Rady Języka Polskiego obowiązującą od 2026 (ortografia, interpunkcja, typografia, kultura języka) z usuwaniem wzorców tekstu generowanego przez ChatGPT, Claude i Gemini. Używaj zawsze, gdy powstaje, jest poprawiany, recenzowany albo tłumaczony na polski dowolny tekst (mail, wiadomość, post na LinkedIna, oferta, strona, materiał firmowy), a także gdy użytkownik prosi o uczłowieczenie lub korektę polskiego tekstu. Zastępuje skille humanizer i poprawna-polszczyzna. Tekst angielski obsługuje skill humanization.
license: MIT
---

# humanizer-pl: poprawnie i po ludzku

Jeden skill do każdego polskiego tekstu. Pracuje w dwóch warstwach, które dawniej były osobnymi skillami:

- **Norma** (`references/norma.md`): czy tekst jest poprawny. Źródło: RJP 2024/2026, WSO PWN, Poradnia PWN.
- **Brzmienie** (`references/wzorce-ai.md`): czy tekst nie brzmi jak model. 33 wzorce AI z przykładami, fałszywe alarmy, sygnały ludzkiego autorstwa.

Gdy warstwy się różnią, norma rozstrzyga, co jest *dopuszczalne*, a ten plik rozstrzyga, czego *używamy*. Przykład: RJP uznaje pauzę za pełnoprawny znak, ale w tekstach wyjściowych jej nie stosujemy (sekcja Kreski).

Tekst angielski idzie do skilla `humanization`. Tekst dwujęzyczny: każda część według swojego skilla.

## Proces

1. **Ustal kanał i rejestr** (sekcja Rejestry). To decyduje o emoji, wielkiej literze grzecznościowej, punktorach i długości.
2. **Pisz albo przepisuj** według `references/wzorce-ai.md`. Przy redakcji cudzego tekstu: przepisuj, nie wycinaj. Pokryj wszystko, co pokrywał oryginał, i zachowaj sens.
3. **Przejdź normę** według `references/norma.md`: wielkie litery, pisownia łączna i rozdzielna, skróty, liczby, interpunkcja, kultura języka, typografia.
4. **Uruchom skaner** na wersji finalnej:
   ```bash
   python3 scripts/sprawdz.py tekst.txt      # albo: echo "..." | python3 scripts/sprawdz.py -
   ```
   Każdy `BŁĄD` poprawiasz. Każde `SPRAWDŹ` oceniasz sam: skaner zna wzorce, nie zna kontekstu.
5. **Checklista** na końcu tego pliku.

### Co oddajesz

- **Nowy tekst w imieniu właściciela** (mail, wiadomość, post): tylko wersję finalną. Audyt robisz po cichu.
- **Prośba o uczłowieczenie, korektę lub recenzję**: wersję finalną i krótką listę tego, co zmieniłeś i dlaczego. Pełną pętlę szkic → „co wciąż brzmi jak AI” → wersja finalna pokazujesz tylko, gdy użytkownik o nią prosi albo tekst jest długi (esej, artykuł).
- **Tekst zewnętrzny** to zawsze szkic do akceptacji właściciela. Nie wysyłasz go ani nie publikujesz.

## Kreski: jedna reguła

Ten fragment zastępuje sprzeczne reguły z obu starych skilli.

| Znak | Gdzie wolno | Gdzie nie |
|---|---|---|
| `—` pauza | tylko dialog w prozie literackiej | wszędzie indziej, także „dla rytmu” |
| `–` półpauza | technicznie, bez spacji: zakresy `2024–2026`, `9:00–17:00`, `s. 12–15`; relacje `Warszawa–Kraków`, `mecz Polska–Niemcy`. Ze spacjami tylko przy członach wielowyrazowych: `Nowy Sącz – Bielsko-Biała` | jako pauza retoryczna w zdaniu |
| `-` łącznik | wewnątrz wyrazów, bez spacji: `biało-czerwony`, `5-letni`, `ZUS-em`, `e-mail` | ze spacjami jako zastępstwo myślnika: `tekst - dopisek` |

Pauzę retoryczną zastępujesz, mniej więcej w tej kolejności: kropką, przecinkiem, dwukropkiem, nawiasem, przebudową zdania. `Proces jest pierwszy — narzędzie potem` → `Najpierw proces. Potem narzędzie.`

Dlaczego tak: częsta pauza w polskim tekście użytkowym to jeden z najsilniejszych sygnałów AI, bo ludzie rzadko ją wstukują. Łącznik ze spacjami to ten sam tik w przebraniu i jednocześnie błąd typograficzny. Półpauza w zakresie to zwykła norma, nie styl, więc zostaje.

## Cudzysłów

Polski cudzysłów to `„…”`: otwierający na dole (U+201E), zamykający u góry (U+201D). Wewnętrzny: `»…«`. Błędy: prosty `"…"`, angielski `“…”`, para `„…“` z dwoma znakami otwierającymi i `„…"` z prostym zamknięciem. Metafor i frazeologizmów nie bierzemy w cudzysłów.

## Rejestry

**Mail i wiadomość do klienta (rejestr relacyjny).** Standardowe otwarcie (`Dzień dobry Panie Tomaszu,`), potem szybko do rzeczy. `Pan`, `Pani`, `Państwo` wielką literą. Po powitaniu z przecinkiem dalej mała litera. Jedna sprawa na wiadomość, konkretne następne działanie na końcu. Lekki humor albo emotikon `:)` na końcu zdania jest w porządku, jeśli relacja na to pozwala. `Z poważaniem` i `Pozdrawiam` bez kropki.

**Post na LinkedIna.** Proza ciągła, bez punktorów i bez kresek retorycznych. Najwyżej jedno emoji, na końcu, po kropce. Jedno miękkie wezwanie. Wielka litera grzecznościowa nie obowiązuje.

**Materiał firmowy, oferta, dokument biznesowy.** Punkty i tabele dozwolone, zero emoji. `Państwo` wielką literą. Pełna nazwa przy pierwszym użyciu, skrót potem. Daty, godziny i kwoty w jednym formacie w całym dokumencie.

**Strona internetowa i opis produktu.** Krótkie akapity, jedno wezwanie na sekcję, nagłówki bez kropki i bez Title Case.

**Szkolenia i slajdy.** Równoległa budowa punktów, bez kropek na końcu równoważników, konsekwentna wielkość liter w nagłówkach.

**Proza literacka.** Pauza dialogowa dozwolona. Wzorce z sekcji „Charakter i głos” w `references/wzorce-ai.md` mają tu największą wagę.

**Rejestr prawny i urzędowy** (umowa, regulamin, pismo procesowe, opinia prawna) jest poza zakresem uczłowieczania. Stosujesz tylko normę i reguły uniwersalne: kreski, cudzysłów, nagłówki bez Title Case, brak emoji i mechanicznych pogrubień, usuwanie artefaktów czatu i wypełniaczy. Nie ruszasz strony biernej, terminów zdefiniowanych („Umowa”, „Wykonawca”), zdań z wieloma warunkami ani terminów ustawowych. Nie dodajesz głosu ani pierwszej osoby.

## Przykładowy styl autora (domyślna próbka)

Gdy użytkownik nie poda innej próbki, kalibruj polski tekst w jego imieniu na tych zdaniach, które sam wskazał jako swój styl:

> Dzień dobry Pani Gabrielo, dziękuję za informację i za przekazanie mojego profilu Managerowi rekrutującemu.

> Dziękuję za szczegółowy feedback, to dość rzadkie zjawisko :) Powodzenia w rekrutacji.

> Cześć, Jasne, rozumiem. W przyszłym tygodniu pasuje mi poniedziałek i wtorek, właściwie o dowolnej porze - daj znać, co Ci pasuje.

Co z nich wynika: grzeczne otwarcie i od razu konkret, krótkie zdania, ciepło przez drobny gest, nie przez przymiotniki, zero korporacyjnej waty. Nie zmyślaj doświadczeń, relacji ani wyników, których autor nie potwierdził.

Uwaga: próbki to autentyczne wiadomości i zostają jak są, także łącznik ze spacjami w trzeciej. W tekstach, które piszesz, stosujesz regułę z sekcji Kreski.

## Checklista przed oddaniem

Każdy punkt to jedno „tak”:

1. Skaner nie zgłasza żadnego `BŁĘDU`, a każde `SPRAWDŹ` zostało ocenione.
2. Brak `—` (poza dialogiem literackim), brak ` - ` w funkcji myślnika, `–` tylko w zakresach i relacjach.
3. Cudzysłowy `„…”`, wewnętrzne `»…«`.
4. Każde zdanie podrzędne ma przecinek, zestawienia (`mimo że`, `podczas gdy`) mają przecinek przed całością, przed pojedynczym `i`/`lub`/`albo`/`ani` przecinka nie ma.
5. `nie` z imiesłowami przymiotnikowymi łącznie, `by` po spójniku rozdzielnie, nazwiska odmienione.
6. Wielkie litery zgodne z normą 2026: mieszkańcy miast wielką, przymiotniki od nazw własnych małą, `ulica` małą.
7. Brak kalk i urzędowszczyzny z tabeli w `references/norma.md`, brak pleonazmów, brak zdań-potwierdzeń bez treści.
8. Brak skupisk wzorców AI: nadymanie znaczenia, doczepki na -ąc, reguła trzech, „nie tylko…, ale…”, seria „Bez… Bez…”, artefakty czatu, asekuracja, ogólnikowe zakończenie.
9. Każda liczba, nazwa, cytat i przysłowie są prawdziwe i masz dla nich źródło.
10. Rejestr pasuje do kanału.
11. Czytany na głos brzmi jak człowiek, a luz wziął się z doboru słów i rytmu, nie z odpuszczonej normy.

## Pochodzenie

Połączenie dwóch skilli: `humanizer` 3.0.0-pl (polska adaptacja skilla humanizer, licencja MIT) oraz `poprawna-polszczyzna`, fork skilla Michała Kolasy (github.com/sequelachi/poprawna-polszczyzna, aimko.tech, licencja MIT). Zmiany: jedna reguła kresek zamiast dwóch sprzecznych, poprawne odwołania między skillami, usunięty odnośnik do nieistniejącego `legal-style-pl` i obcej „reguły domowej”, poprawny cudzysłów zamykający w całym tekście, usunięte duplikaty (kalki, pleonazmy), dodany skaner i domyślna próbka stylu autora.
