---
name: poprawna-polszczyzna
description: Pisanie po polsku na luzie, ale bez błędu — norma Rady Języka Polskiego obowiązująca od 2026, kultura języka, typografia, weryfikacja cytatów i przysłów. Rejestry dopasowane do komunikacji biznesowej i social media (nie do pism prawnych).
---

# Poprawna polszczyzna

Fork skilla [poprawna-polszczyzna](https://github.com/sequelachi/poprawna-polszczyzna) autorstwa Michała Kolasy (aimko.tech, licencja MIT). Zmiany względem oryginału: usunięto zależność od jego Tone of Voice, podłączono kolizję myślnika pod skill `humanization`, poszerzono i zmieniono rejestry pod komunikację biznesową i social media — bez rejestru prawnego, bo tym zajmuje się ktoś inny.

## Trigger

Uruchamiaj ten skill zawsze, kiedy powstaje albo jest poprawiany tekst po polsku: post na LinkedIna, mail lub wiadomość do klienta, materiał firmowy / projektowy, oferta, opis produktu, treść na stronę. Uruchamiaj go także przy korekcie tekstu napisanego przez kogoś innego oraz przy tłumaczeniu na polski.

Ten skill odpowiada za **poprawność**. Za brzmienie i AI-tells odpowiada `humanization`. Stosuj oba razem; przy kolizji czytaj punkt 6.

## Źródło normy

1. **Rada Języka Polskiego przy Prezydium PAN, „Zasady pisowni i interpunkcji polskiej", Warszawa 2024.** Pierwszy oficjalny zbiór przepisów ogłoszony na mocy Ustawy z dnia 7 października 1999 r. o języku polskim (art. 31). Zmiany uchwalone 7 listopada 2022, 3 lutego 2023 i 22 stycznia 2024 obowiązują od 1 stycznia 2026 — to już bieżąca norma, nie projekt.
2. **Wielki słownik ortograficzny PWN** (sjp.pwn.pl/so) przy pisowni pojedynczych wyrazów.
3. **Poradnia językowa PWN** (sjp.pwn.pl/poradnia) przy sprawach nieujętych w przepisach.

Uwaga praktyczna: część zasad na sjp.pwn.pl pochodzi sprzed reformy. Przy rozbieżności obowiązuje dokument Rady z 2024 roku.

## Steps

1. Napisz tekst.
2. Przejdź listę ortograficzną (punkty 1–4).
3. Przejdź interpunkcję (punkt 5).
4. Przejdź kulturę języka (punkt 7).
5. Sprawdź typografię (punkt 8).
6. Dopasuj rejestr do kanału (punkt 9).
7. Przejdź checklistę (Verification).

---

## 0. Zasada nadrzędna: luz po polsku

Luz robimy leksyką, rytmem i składnią, nigdy ortografią, interpunkcją i odmianą.

### Co wolno i jest w pełni poprawne

- Zaczynanie zdania od `A`, `I`, `Ale`, `No i`.
- Równoważniki zdań i elipsy.
- Słownictwo potoczne notowane przez słowniki jako potoczne, nie błędne: `robota`, `ekipa`, `dogadać się`, `wąskie gardło`, `bałagan`.
- Zdania długie, wielokrotnie złożone — pod warunkiem że przecinki stoją tam, gdzie każe punkt 5.
- Przysłowia i ich świadome przeróbki, jeśli oryginał zostaje rozpoznawalny i zmieniamy jeden element, nie trzy.
- Pytania retoryczne, zwroty do czytelnika, tryb rozkazujący w wezwaniu.
- Wtrącenia w nawiasie zamiast pauzy myślnikiem.
- Emoji na końcu zdania albo akapitu, po kropce — nigdy zamiast kropki, nigdy w środku zdania.
- Rezygnacja z wielkiej litery grzecznościowej w poście — to wybór stylistyczny.

### Co nie jest luzem, tylko błędem

- Formy odrzucone przez normę: `poszłem`, `wziąść`, `włanczać`, `przekonywujący`, `w każdym bądź razie`, `widzę tą panią`.
- Brak przecinka przed `że`, `który`, `bo`, `gdy`, `jeśli`.
- Nieodmienione nazwisko.
- Kalki z angielskiego z tabeli w punkcie 7.
- Prosty cudzysłów `" "` zamiast `„ "`.
- Błąd imiesłowowy, pleonazm, powtórzenie tego samego słowa w jednym zdaniu.

### Test na luz

Przeczytaj tekst na głos. Jeśli brzmi jak wypracowanie, skróć zdania. Jeśli zgrzyta przecinek albo odmiana, popraw normę, nie ton.

---

## 1. Wielka i mała litera

### Wielką literą

- Nazwy firm, marek, modeli i pojedynczych egzemplarzy: `Cyfrowy Polsat`, `jeździ czerwonym Fordem`.
- Nazwy mieszkańców państw, regionów, miast, dzielnic, osiedli i wsi: `Polak`, `Warszawiak`, `Mokotowianin` — **zmiana od 2026**, wcześniej mieszkańców miast pisano małą literą.
- Nazwy urzędów, instytucji, szkół, uczelni, organizacji: `Ministerstwo Rozwoju i Technologii`, `Uniwersytet Łódzki`. Wewnętrzne przyimki i spójniki oraz `imienia`, `do spraw`, `na rzecz`, `numer` małą literą.
- Nazwy obiektów przestrzeni publicznej z wyrazem rodzajowym: `Plac Zbawiciela`, `Stadion Narodowy`. **Wyjątek: `ulica` zawsze małą literą**, `ulica Piotrkowska`.
- Nazwy lokali i instytucji kultury z wyrazem rodzajowym: `Hotel Zamkowy` (dopuszczalne też `hotel Zamkowy` jako określenie gatunkowe).
- Nazwy nagród, orderów, tytułów honorowych: `Nagroda Nobla`.
- Nazwy świąt, imprez, konkursów, akcji: `Boże Narodzenie`, `Wielka Orkiestra Świątecznej Pomocy`.
- Tytuły czasopism i cykli: wszystkie wyrazy poza wewnętrznymi przyimkami/spójnikami.

### Małą literą

- Przymiotniki od nazw własnych: `dramat szekspirowski`, `polskie przepisy` — **zmiana od 2026**.
- Dni tygodnia, miesiące, epoki, prądy: `wtorek`, `romantyzm` (epoki dopuszczalne też wielką).
- Wydarzenia historyczne: `powstanie warszawskie`.
- Województwa, powiaty i jednostki administracyjne: `województwo łódzkie`.
- Typy instytucji: `bank`, `szkoła`, `uniwersytet`.
- Stanowiska, godności, tytuły: `prezes`, `dyrektor`, `minister`.
- Marki w znaczeniu rodzajowym: `adidasy`, `xero`.

### Wielka litera grzecznościowa

Indywidualna decyzja. W mailu i wiadomości do klienta: `Pan`, `Pani`, `Państwo` wielką literą. W poście społecznościowym — nie, bo mówisz do wielu osób naraz i wygląda to sztucznie.

### Tytuły dzieł, ustaw i dokumentów

Wielką literą tylko pierwszy wyraz i te, które i tak jej wymagają: `Kodeks pracy`, `Ziemia obiecana`. Wyjątki tradycyjne: `Pismo Święte`.

---

## 2. Pisownia łączna, rozdzielna i z łącznikiem

### Cząstka `nie-`

**Łącznie** z rzeczownikami, przymiotnikami we wszystkich stopniach, **z imiesłowami przymiotnikowymi zawsze, bez wyjątków** (`niepalący`, `nieprzeszkolony`, `niewdrożony`) — bezwyjątkowość to zmiana od 2026 — i z przysłówkami odprzymiotnikowymi.

**Rozdzielnie** przed czasownikami, przed `brak`, `można`, `potrzeba`, `trzeba`, `warto`, `wiadomo`, `wolno`, przed imiesłowami przysłówkowymi, przed formami na `-no`/`-to`, przed liczebnikami, zaimkami, wyrażeniami przyimkowymi, przed `byle`, `lada`, w `nie fair`, `nie serio`, `nie wprost`. Rozdzielnie też, gdy `nie` jednocześnie zaprzecza i przeciwstawia (`nie proces, ale narzędzie`) i po `bynajmniej`, `wcale`.

### Cząstka `by`

**Łącznie** z formami osobowymi czasownika: `zrobiłbym`, `należałoby`.

**Rozdzielnie** po bezokoliczniku, po formach na `-no`/`-to`, po `można`/`trzeba`/`warto`/`wolno`, po `winien`/`powinien`, **po spójnikach** (`albo by został`, `czy by nie pojechać`) — **zmiana od 2026** — i po innych częściach mowy.

Zawsze łącznie: `aby`, `żeby`, `gdyby`, `jakby`, `choćby`, `czyżby`, `niby`, `oby`.

### Przysłówek plus imiesłów lub przymiotnik

Rozdzielnie: `wolno stojący`, `nowo otwarty`, `świeżo malowany`. Łącznie tylko dla terminów/nazw produktów utrwalonych: `zestaw głośnomówiący`, `stal szybkotnąca`. **W razie wątpliwości — rozdzielnie.**

### Łącznik

- Człony równorzędne: `szkoleniowo-doradczy`, `biało-czerwony`.
- Trzy i więcej członów: `północno-wschodnio-polski`.
- Człony nierównorzędne razem: `ciemnoniebieski`, `ponadstuletni`.
- Liczba/litera w pierwszej części: `5-złotowy`, `80-letni`, `3-osobowy`.
- Nazwiska dwuczłonowe i nazwy miejscowe złożone: `Bielsko-Biała`. Bez łącznika, gdy przymiotnik zgadza się z rzeczownikiem: `Nowy Sącz`.
- Przedrostek przed wielką literą: `eks-Niemiec`.

### Element `pół`

Rozdzielnie, gdy oznacza połowę + dopełniacz: `pół roku`, `pół etatu`. Łącznie, gdy tworzy nowy wyraz: `półroczny`, `półfinał`.

### Cząstki `super-`, `mini-`, `mega-`, `eko-`, `ekstra-`, `makro-`, `mikro-`, `turbo-`

Dopuszczalna łączna albo rozdzielna: `superpomysł`/`super pomysł`. Terminologiczne utrwalone zawsze łącznie: `supermarket`, `ekstraklasa`. Przed czasownikiem, zaimkiem, liczebnikiem — wyłącznie rozdzielnie: `super się bawiliśmy`.

### Skrótowce w odmianie

`ZUS-em`, `PAN-u`, `UMCS-u`. Bez kropek, bez dzielenia przy przenoszeniu.

---

## 3. Skróty

**Bez kropki**, gdy skrót ma ostatnią literę wyrazu: `dr`, `mgr`, `nr`. Też polskie jednostki monetarne (`zł`, `gr`), miary (`kg`, `km`, `l`), kody walut (`PLN`, `EUR`, `USD`).

**Z kropką**, gdy odcięto końcówkę: `prof.`, `ul.`, `godz.`, `np.`, `ok.`, `itd.`, `itp.`

**Kropka po każdym członie**, gdy kolejny człon zaczyna się od samogłoski: `m.in.`, `p.o.`

**W przypadku zależnym skrót dostaje kropkę**, bo ginie ostatnia litera: `artykuł dr. Kowalskiego`. Skrót tytułu kobiety bez kropki: `rozmawiałem z dr Anną Nowak`.

**Nigdy z ukośnikiem**: `wg`, nie `w/g`; `ds.`, nie `d/s`.

Jeśli zdanie kończy się skrótem z kropką, nie stawiamy drugiej kropki.

---

## 4. Liczby, daty i godziny

- Liczebnik porządkowy cyfrą arabską dostaje kropkę: `w 3. kwartale`. Można pominąć, gdy kontekst jest jasny.
- Po cyfrach rzymskich bez kropki: `XV wiek`.
- Po liczebnikach głównych bez kropki: `40 dni`.
- Data cyframi arabskimi: kropki, `31.08.2026`. Miesiąc słownie/rzymski: bez kropek, `31 sierpnia 2026 r.`
- Godziny: `9.00–17.00` lub `9:00–17:00` — wybierz jeden zapis, trzymaj się go w dokumencie.
- Procent bez odstępu: `40%`. `- 40 %` jest błędne.
- W prozie liczby do dziesięciu słownie, powyżej cyframi. Dane, kwoty, wyniki i daty zawsze cyframi.

---

## 5. Interpunkcja

### Przecinek: stawiamy zawsze

- Przed zdaniem podrzędnym, niezależnie od szyku.
- Zdanie wtrącone wydzielamy z obu stron.
- Przed spójnikami przeciwstawnymi (`a`, `ale`, `lecz`, `jednak`, `natomiast`, `zaś`), wynikowymi (`więc`, `dlatego`, `zatem`) i synonimicznymi (`czyli`, `to jest`).
- Między jednorodnymi częściami zdania bez spójnika.
- Przy powtórzonym spójniku: `i… i…`, `albo… albo…`.
- Przy imiesłowach na `-ąc`, `-łszy`, `-wszy` — wyjątek: nie stawiamy przecinka między imiesłowem a bezpośrednio poprzedzającym go spójnikiem/zaimkiem względnym.
- Przy wołaczu.
- Przy wyrazach spoza zdania: `Oczywiście, pomożemy`.

### Przecinek: nie stawiamy

- Przed `i`, `oraz`, `lub`, `albo`, `bądź`, `czy`, `ani`, `ni`, jeśli spójnik nie jest powtórzony.
- Przed `a` w funkcji łącznej i porównawczej, i w `między… a…`.
- Między przydawkami nierównorzędnymi.
- Między dwoma sąsiadującymi spójnikami.
- Przed członem porównawczym z `jak`, `jakby`, `niby`, `niczym`, `niż` w zdaniu pojedynczym.

### Spójniki zestawione

Przecinek **przed całym zestawieniem**: `mimo że`, `chyba że`, `zwłaszcza że`, `podczas gdy`, `dlatego że`, `tym bardziej że`. Ale gdy `tak`/`tam`/`wtedy` wprowadza zdanie podrzędne, przecinek rozdziela zestawienie: `Przyjdę wtedy, gdy mnie przeprosisz`.

### Dwukropek

Przed wyliczeniem zapowiedzianym określeniem ogólnym, przed cytatem, przed wyjaśnieniem zdania poprzedzającego. Nie stawiamy, gdy brak zapowiedzi, przy dwóch członach ze spójnikiem `i`, przy orzeczeniu w liczbie pojedynczej.

### Wykrzyknik i formuły korespondencji

Po powitaniu z wykrzyknikiem — wielka litera dalej. Po powitaniu z przecinkiem — mała. Po formule kończącej list nie stawiamy kropki:

```
Z poważaniem
Jan
```

### Pytajnik

Nie stawiamy, gdy pytające jest zdanie podrzędne: `Nie wiem, czy pojadę`. Stawiamy, gdy pytające jest zdanie nadrzędne: `Czy wiesz, o której zaczyna się spotkanie?`

### Cudzysłów

Polski `„ "`, nie `" "`. Wewnętrzny: `» «`. Nie bierzemy w cudzysłów metafor ani frazeologizmów. Kropka po cudzysłowie zamykającym.

### Zbieg znaków

Bez kropki po wykrzykniku, pytajniku, wielokropku. Z kropką po nawiasie i cudzysłowie zamykającym.

---

## 6. Myślnik — kolizja z `humanization`

Rada Języka Polskiego traktuje myślnik jako pełnoprawny znak. Twój skill `humanization` zakazuje em dasha w tekście nie-fikcyjnym niezależnie od języka — to nie jest sprzeczność z normą, tylko wybór stylu ponad tym, co norma dopuszcza.

1. **Znak `—` nie pojawia się w tekstach nie-fikcyjnych.** To najczęstszy odcisk palca AI, w polskim tak samo jak w angielskim.
2. **Myślnika w funkcji pauzy retorycznej nie używamy.** Zamiast niego: przecinek, dwukropek, kropka, albo przebudowa zdania. `Proces jest pierwszy — narzędzie potem` → `Najpierw proces. Potem narzędzie.`
3. **Półpauzy `–` używamy wyłącznie technicznie** — to nie łamie zasady, bo to nie pauza retoryczna: zakresy liczb i dat (`2024–2026`), relacja „przeciwko" (`Widzew – ŁKS`), wypunktowania, dialogi w tekstach literackich (fikcja ma osobną, węższą furtkę w `humanization`).
4. W razie wątpliwości przebuduj zdanie. Prawie zawsze się da.

---

## 7. Kultura języka

### Kalki i urzędowszczyzna do wycięcia

| Zamiast | Piszemy |
|---|---|
| odnośnie czegoś | odnośnie do czegoś, a najlepiej: co do, jeśli chodzi o, w sprawie |
| w oparciu o | na podstawie |
| w każdym bądź razie | w każdym razie |
| póki co | na razie, tymczasem |
| dedykowany (o narzędziu) | przeznaczony dla, zrobiony pod |
| adresować problem | zająć się problemem, rozwiązać |
| dostarczać wartość | dawać coś konkretnego, oszczędzać czas |
| implementacja, implementować | wdrożenie, wdrożyć |
| tylko i wyłącznie | tylko |
| w dniu dzisiejszym | dziś |
| w chwili obecnej | teraz |
| celem usprawnienia | żeby usprawnić |
| z uwagi na fakt, że | bo, ponieważ |
| posiadać (o zwykłych rzeczach) | mieć |
| wychodzić naprzeciw oczekiwaniom | wytnij całe zdanie |
| training, call, tool, feedback | szkolenie, spotkanie, narzędzie, informacja zwrotna |

`Odnośnie czegoś` bez `do` jest uznawane za błąd (Poradnia PWN, prof. Mirosław Bańko). `W oparciu o` nie jest już błędem, ale jest nadużywane — domyślnie piszemy `na podstawie`.

### Fleksja i składnia

- Biernik: `widzę tę panią`, nie `tą`. `Tą` tylko w narzędniku.
- `wziąć` nie `wziąść`, `poszedłem` nie `poszłem`, `przekonujący` nie `przekonywujący`, `włączać` nie `włanczać`.
- `bynajmniej` znaczy „wcale nie", nie „przynajmniej".
- Liczebniki: `dwa tysiące dwudziestego szóstego roku`, nie `dwutysięcznego dwudziestego szóstego`. `procent` po liczebniku się nie odmienia: `o pięć procent`.
- Zgoda podmiotu z orzeczeniem: `część zespołu korzysta`, nie `korzystają`.
- **Nazwiska odmieniamy.** `rozmowa z Michałem Kolasą`. Nieodmienianie polskiego nazwiska jest błędem.
- Rząd czasownika: `podobny do kogoś`, nie `podobny komuś`.
- Błąd imiesłowowy: imiesłów na `-ąc` wymaga tego samego podmiotu i czynności równoczesnej. Błędnie: `Wchodząc do firmy, powitał mnie zarząd` (dwa różne podmioty).

### Frazeologia

`twardy orzech do zgryzienia`, nie `ciężki orzech`. `odgrywać rolę`/`mieć znaczenie`, nie `odgrywać znaczenie`. `ponosić koszty`, nie `ponosić wydatki`. `brać pod uwagę`, nie `brać na uwagę`.

### Pleonazmy i powtórzenia

Wycinamy: `cofać się do tyłu`, `okres czasu`, `kontynuować dalej`, `fakt autentyczny`, `potencjalne możliwości`. Jeśli to samo słowo wraca w jednym zdaniu, przebuduj zdanie. Wycinamy zdania, które tylko potwierdzają, nic nie wnosząc: `Świetnie to ujmujesz`, `zgadzam się w pełni`.

---

## 8. Typografia polska

- Twarda spacja po jednoliterowych przyimkach i spójnikach `a`, `i`, `o`, `u`, `w`, `z`.
- Cudzysłów `„ "`, apostrof `'`, wielokropek jako jeden znak `…`.
- Zawsze polskie znaki diakrytyczne, także w nagłówkach i wersalikach.
- Separator dziesiętny: przecinek (`3,5 godziny`). Separator tysięcy: spacja nierozdzielająca (`1 500 zł`).
- Jednostki miar ze spacją: `10 kg`. Procent bez spacji: `40%`. Kwota przed skrótem waluty: `1500 zł`.
- Nie zapisujemy całych zdań wersalikami.
- Bez podwójnych spacji ani spacji przed przecinkiem, kropką, dwukropkiem, średnikiem, pytajnikiem, wykrzyknikiem.

---

## 9. Rejestry

**Post na LinkedIna.** Proza ciągła, bez punktorów, bez myślników — przecinki i kropki zamiast pauz. Jedno emoji na końcu, jedno miękkie wezwanie. Wielka litera grzecznościowa nie obowiązuje. (Zderz z `references/linkedin.md` z `humanization` — ten skill pilnuje poprawności, tamten pilnuje, żeby nie brzmiało jak AI.)

**Mail i wiadomość do klienta.** Formuła powitalna z przecinkiem, mała litera dalej. Jedna sprawa na wiadomość. Konkretne następne działanie na końcu. `Z poważaniem` bez kropki.

**Materiał firmowy / dokument biznesowy.** Punkty i tabele dozwolone, zero emoji, wielka litera grzecznościowa przy `Państwo`, pełna nazwa przy pierwszym użyciu i skrót dopiero potem, daty i kwoty w jednym formacie w całym dokumencie.

**Strona internetowa i opis produktu.** Krótkie akapity, jedno wezwanie na sekcję, nagłówki bez kropki na końcu.

**Materiały szkoleniowe i slajdy.** Równoległa budowa punktów, bez kropek na końcu równoważników, konsekwentna wielkość liter w nagłówkach.

*Rejestr prawny/formalno-instytucjonalny celowo pominięty — to nie Twój zakres.*

---

## 10. Kiedy sprawdzać w źródle, a nie zgadywać

Zawsze przy: `ó`/`u`, `rz`/`ż`, `ch`/`h` w rzadkim wyrazie; odmianie obcego nazwiska; pełnej nazwie instytucji lub firmy; wątpliwym przecinku przed spójnikiem zestawionym; skrócie spoza listy w punkcie 3.

Kolejność: dokument Rady z 2024, potem Wielki słownik ortograficzny PWN (sjp.pwn.pl/so), potem Poradnia PWN (sjp.pwn.pl/poradnia).

Nazw własnych i cytatów nie poprawiamy, nawet z błędem — zaznacz `(sic!)`.

---

## 11. Cytaty i przysłowia

Zmyślony cytat albo przysłowie przypisane nie tej osobie kosztuje wiarygodność natychmiast.

**Gdzie sprawdzać:** Wikicytaty (pl.wikiquote.org) — strony osób i dzieł, dział „Przysłowia polskie" (`pl.wikiquote.org/wiki/Przysłowia_polskie/N`). Hasło bez linijki `Źródło:` to wskazówka, nie potwierdzenie.

**Zasady:**
1. Przysłowie bez autora — nie podajemy źródła, ale sprawdzamy, że istnieje w tej postaci.
2. Cytat konkretnej osoby — podajemy autora tylko gdy Wikicytaty wskazują publikację, albo masz tekst źródłowy w ręku. Bez źródła — nie cytujemy.
3. Cytatu nie poprawiamy. Błąd oznacz `(sic!)`.
4. Przeróbka przysłowia — dozwolona, oryginał musi zostać rozpoznawalny, zmieniamy jeden element, nie trzy.
5. Przysłowie ma pasować do tezy, nie odwrotnie. Jeśli musisz naciągać sens, wytnij je.

---

## Verification

Przed publikacją, każdy punkt to jedno „tak":

1. Brak znaku `—` i żaden myślnik nie pełni funkcji pauzy retorycznej?
2. Każde zdanie podrzędne ma przecinek, a przed pojedynczym `i`/`lub`/`albo`/`ani` przecinka nie ma?
3. Zestawienia (`mimo że`, `podczas gdy`) mają przecinek przed całością?
4. Imiesłowy na `-ąc`/`-łszy`/`-wszy` wydzielone przecinkiem, ten sam podmiot co zdanie główne?
5. `nie` z imiesłowami/przymiotnikami łącznie, przed czasownikami/`warto`/`można`/`trzeba` rozdzielnie?
6. `by` po spójniku rozdzielnie?
7. Wielkie litery zgodne z punktem 1 (`ulica` małą, mieszkańcy miast wielką, przymiotniki od nazw własnych małą)?
8. Skróty z kropkami tam, gdzie trzeba, brak `w/g`, `d/s`?
9. Cudzysłowy polskie `„ "`, bez metafor/frazeologizmów w cudzysłowie?
10. Daty, godziny, liczby — jeden format w całym tekście, procent bez spacji?
11. Brak kalk z punktu 7, powtórzeń w jednym zdaniu, zdań-potwierdzeń bez treści?
12. Każda liczba i nazwa prawdziwa i ma źródło, które potrafisz wskazać?
13. Nazwiska odmienione?
14. Rejestr pasuje do kanału z punktu 9?
15. Przysłowie istnieje w tej postaci, cytat ma autora i publikację, które potrafisz wskazać?
16. Czytany na głos brzmi jak rozmowa, nie jak wypracowanie ani maszyna?

Ostatnie pytanie: czy luz wziął się z doboru słów i rytmu, a nie z odpuszczonej normy? Jeśli tak — gotowe.
