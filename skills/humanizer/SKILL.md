---
name: humanizer
version: 3.0.0-pl
description: |
  Usuwa znamiona tekstu generowanego przez AI z tekstów po polsku. Używaj przy
  redakcji lub recenzji polskiego tekstu, żeby brzmiał naturalnie i po ludzku.
  Oparte na polskich źródłach normatywnych (Poradnia Językowa PWN, Wielki słownik
  ortograficzny PWN) oraz na obserwacjach polskich tekstów z ChatGPT, Claude i
  Gemini. Wykrywa i poprawia m.in.: napuszone podkreślanie znaczenia, język
  promocyjny, płytkie „co podkreśla / odzwierciedla" doczepki, mgliste
  przypisania źródeł, nadużycie myślnika, regułę trzech, słownictwo typowe dla
  AI, stronę bierną z ukrytym sprawcą, paralelizmy przeczące, anglicyzmy i kalki
  oraz wypełniacze. Uwaga: rejestr prawniczy i urzędowy ma własne normy i nie
  podlega „uczłowieczaniu".
license: MIT
compatibility: claude-code opencode
allowed-tools:
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - AskUserQuestion
---

# Humanizer: usuwanie znamion tekstu AI (wersja polska)

Skill redaguje teksty po polsku, usuwając znamiona tekstu generowanego przez AI. Niniejszy przewodnik jest polskim odpowiednikiem skilla „humanizer" - nie tłumaczeniem słowo w słowo, lecz adaptacją do realiów polszczyzny. Część reguł działa w języku polskim odmiennie niż w angielskim (cudzysłów, myślnik), a niektóre wzorce angielskie w polskim nie występują i zostały zastąpione zjawiskami właściwymi polszczyźnie.

## Twoje zadanie

Gdy dostajesz tekst do uczłowieczenia:

1. **Zidentyfikuj wzorce AI** - przeskanuj tekst pod kątem wzorców z listy poniżej.
2. **Przepisuj, nie usuwaj** - zastępuj sztuczne sformułowania naturalnymi i pokryj wszystko, co pokrywał oryginał. Jeśli oryginał ma pięć akapitów, przepisana wersja ma pięć akapitów.
3. **Zachowaj sens** - nie gub głównego przekazu.
4. **Dopasuj rejestr** - trzymaj się zamierzonego tonu (formalny, swobodny, techniczny, prawniczy). Osobowość dodawaj tylko wtedy, gdy treść i głos autora tego wymagają (patrz CHARAKTER I GŁOS).

Pętla szkic → audyt → wersja finalna oraz forma dostarczenia są opisane na końcu, w sekcji Proces i wynik.

## WYJĄTEK: rejestr prawniczy i urzędowy

Jeśli tekst jest umową, klauzulą, pismem procesowym, opinią prawną,
regulaminem albo innym tekstem w rejestrze prawniczym lub urzędowym,
**nie stosujesz** części reguł z tego skilla - bo w tym rejestrze
poprawiłyby tekst pozornie, a faktycznie by go zepsuły. Do takich
tekstów użyj osobnego skilla `legal-style-pl`, a nie tego.

Konkretnie, w rejestrze prawniczym NIE egzekwujesz:

- **Strony biernej (punkt 13).** Polskie formy nieosobowe -no / -to
  („ustalono", „stwierdzono", „uchwalono") oraz strona bierna
  w opisie stanu prawnego są naturalne i poprawne. Nie zamieniaj ich
  na siłę na stronę czynną.
- **Wariacji synonimicznej (punkt 11).** Tekst prawniczy wymaga
  powtarzania. Termin zdefiniowany („Umowa", „Wykonawca", „Oprogramowanie")
  musi być używany identycznie przez cały dokument. Nie podmieniaj go
  na synonimy - to nie jest sztampa, to wymóg precyzji.
- **Rozbijania zdań złożonych (punkty 9 i 31).** W klauzulach zdania
  z wieloma warunkami („z zastrzeżeniem", „chyba że", „o ile",
  „pod warunkiem że") są normą i nie wolno ich upraszczać kosztem treści.
- **Wycinania słownictwa formalnego jako „suchego" (sekcja
  WSKAZÓWKI DETEKCYJNE).** Terminy ustawowe i pojęcia prawne
  („roszczenie windykacyjne", „bezpodstawne wzbogacenie", „skarga
  pauliańska", „należyta staranność") zostają bez zmian.
- **Dodawania osobowości i głosu (sekcja CHARAKTER I GŁOS).**
  W tekście prawniczym neutralny, rzeczowy ton JEST właściwym głosem.
  Zero opinii, zero pierwszej osoby, zero żartów, zero dygresji.

Reguły, które obowiązują **tak samo** w obu rejestrach (i które warto
stosować również w tekstach prawniczych): myślnik i półpauza (punkt 14),
cudzysłów polski (punkt 19), nagłówki bez Title Case (punkt 17), brak
emoji (punkt 18), brak mechanicznych pogrubień (punkt 15), usuwanie
artefaktów rozmowy z chatbotem (punkt 20: „mam nadzieję, że to pomoże",
„daj znać"), usuwanie słownictwa AI (punkt 7) oraz wypełniaczy
i asekuracji (punkty 23-24).

## Kalibracja głosu (opcjonalnie)

Jeśli użytkownik poda próbkę swojego pisania (własny wcześniejszy tekst), przeanalizuj ją przed przepisaniem:

1. **Najpierw przeczytaj próbkę.** Zwróć uwagę na:
   - Długość zdań (krótkie i dobitne? długie i płynne? mieszane?)
   - Poziom słownictwa (potoczny? akademicki? pośredni?)
   - Sposób rozpoczynania akapitów (od razu do rzeczy? najpierw kontekst?)
   - Nawyki interpunkcyjne (dużo nawiasów? wtrącenia? średniki?)
   - Powracające zwroty i tiki językowe
   - Sposób budowania przejść (jawne łączniki czy po prostu nowa myśl?)

2. **Odwzoruj głos autora w przepisaniu.** Nie tylko usuwaj wzorce AI - zastępuj je wzorcami z próbki. Jeśli autor pisze krótkimi zdaniami, nie produkuj długich. Jeśli używa słów „rzecz" i „coś", nie podnoś ich do „element" i „komponent".

3. **Gdy nie ma próbki,** wróć do zachowania domyślnego (naturalny, zróżnicowany głos z sekcji CHARAKTER I GŁOS poniżej).

### Jak podać próbkę
- W treści wiadomości: „Uczłowiecz ten tekst. Oto próbka mojego pisania jako wzorzec głosu: [próbka]".
- Jako plik: „Uczłowiecz ten tekst. Jako wzorzec stylu użyj pliku [ścieżka]".

## CHARAKTER I GŁOS

Eliminowanie wzorców AI to tylko połowa zadania. Tekst sterylny i bezbarwny jest równie rozpoznawalny co sztampa. Za dobrym tekstem stoi konkretny autor.

**Tę sekcję stosuj tylko wtedy, gdy treść i głos autora tego wymagają** - wpisy blogowe, eseje, felietony, teksty osobiste. Dla tekstów encyklopedycznych, technicznych, **prawniczych i urzędowych** neutralny i rzeczowy ton *jest* właściwym głosem. Nie wstrzykuj tam opinii ani pierwszej osoby. Pismo procesowe ma brzmieć jak pismo procesowe, opinia prawna jak opinia prawna - rejestr formalny wyklucza zabiegi charakterologiczne.

### Oznaki tekstu bez wyraźnego głosu (nawet jeśli technicznie „czysty"):
- Jednolita długość i struktura zdań
- Brak ocen, samo neutralne relacjonowanie
- Brak sygnałów niepewności lub ambiwalencji
- Brak pierwszej osoby tam, gdzie byłaby uzasadniona
- Brak humoru, indywidualności, wyraźnego stanowiska
- Styl bliski hasłu encyklopedycznemu lub notatce prasowej

### Jak wprowadzić głos autora:

**Formułuj oceny.** Nie tylko relacjonuj fakty - reaguj na nie. „Sam nie wiem, co o tym myśleć" jest bardziej autentyczne niż neutralne zestawienie argumentów za i przeciw.

**Różnicuj rytm zdań.** Krótkie, dobitne zdania. A potem dłuższe, które spokojnie prowadzą do konkluzji. Mieszanka obu jest oznaką świadomego pisarstwa.

**Dopuść pewien nieład.** Idealna struktura brzmi algorytmicznie. Dygresje, wtrącenia i niedomknięte wątki są oznaką myśli w ruchu.

### Przykład - PRZED (czysto, ale bez duszy):
> Eksperyment przyniósł interesujące wyniki. Agenty wygenerowały 3 miliony linii kodu. Część programistów była pod wrażeniem, inni byli sceptyczni. Implikacje pozostają niejasne.

### Przykład - PO (z pulsem):
> Sam nie wiem, jak to ocenić. Trzy miliony linii kodu, napisane w nocy, kiedy ludzie spali. Połowa branży świętuje, druga połowa tłumaczy, czemu to się nie liczy. Prawda jest pewnie gdzieś pośrodku i nudna, ale nie mogę przestać myśleć o tych agentach robiących swoje po ciemku.

## WZORCE TREŚCI

### 1. Nadmierne podkreślanie znaczenia, dziedzictwa i „szerszych trendów"

**Słowa na celowniku:** stanowi świadectwo / dowód, odgrywa kluczową / istotną / fundamentalną rolę, podkreśla znaczenie / wagę, wpisuje się w szerszy trend / kontekst, na trwałe zapisał się, kamień milowy, punkt zwrotny, wyznacza kierunek, kształtuje, odcisnął piętno, głęboko zakorzeniony, w obliczu, na przestrzeni lat, symbolizuje trwałe

**Problem:** AI nadyma znaczenie, dodając zdania o tym, jak przypadkowy element „reprezentuje" albo „wpisuje się" w jakiś większy temat.

**PRZED:**
> Instytut Statystyki Katalonii został oficjalnie powołany w 1989 roku, co stanowiło punkt zwrotny w ewolucji statystyki regionalnej w Hiszpanii. Inicjatywa ta wpisywała się w szerszy ruch decentralizacji administracji i wzmacniania samorządności.

**PO:**
> Instytut Statystyki Katalonii powołano w 1989 roku, aby zbierał i publikował statystyki regionalne niezależnie od krajowego urzędu statystycznego.

### 2. Nadmierne podkreślanie rozpoznawalności i obecności w mediach

**Słowa na celowniku:** był szeroko opisywany w mediach, cieszy się dużą popularnością w mediach społecznościowych, zyskał uznanie, niezależne źródła, lokalne / ogólnopolskie media

**Problem:** AI nagromadza deklaracje o rozpoznawalności i medialnej widoczności, często wymieniając media bez podania konkretnej treści.

**PRZED:**
> Jej poglądy były cytowane w wielu prestiżowych mediach. Prowadzi aktywny profil w mediach społecznościowych z ponad 500 tysiącami obserwujących.

**PO:**
> W wywiadzie dla „Gazety Wyborczej" z 2024 roku argumentowała, że regulacje AI powinny skupiać się na skutkach, a nie na metodach.

### 3. Płytkie doczepki: imiesłowy na -ąc i ogony „co + czasownik"

**Słowa na celowniku:** podkreślając, odzwierciedlając, przyczyniając się do, kształtując, ukazując, obejmując; ogony typu „co podkreśla jego znaczenie", „co odzwierciedla", „co czyni go", „tym samym przyczyniając się do"

**Problem:** AI doczepia do zdań imiesłowy przysłówkowe (-ąc) i frazy „co...", żeby udać głębię. Polskim odpowiednikiem angielskiego „-ing" jest właśnie ta doczepka.

**PRZED:**
> Paleta świątyni - niebieski, zielony i złoty - rezonuje z naturalnym pięknem regionu, symbolizując łubin teksański i Zatokę Meksykańską, odzwierciedlając głęboką więź społeczności z ziemią.

**PO:**
> Świątynia ma kolory niebieski, zielony i złoty. Architekt wybrał je w nawiązaniu do miejscowego łubinu i wybrzeża Zatoki.

### 4. Język promocyjny i reklamowy

**Słowa na celowniku:** malowniczy, urokliwy, tętniący życiem, bogaty (w przenośni), zapierający dech, niezapomniany, wyjątkowy, kultowy, słynący z, perła (regionu), w sercu (miasta), malowniczo położony, must-see, przełomowy (w przenośni)

**Problem:** AI ma trudność z utrzymaniem neutralnego tonu, szczególnie przy tematach z zakresu dziedzictwa kulturowego lub turystyki.

**PRZED:**
> Malowniczo położone w sercu zapierającego dech regionu, miasteczko tętni życiem, szczyci się bogatym dziedzictwem kulturowym i niezapomnianymi krajobrazami.

**PO:**
> Miasteczko leży w regionie X i znane jest z cotygodniowego targu oraz osiemnastowiecznego kościoła.

### 5. Mgliste przypisania i słowa-wytrychy

**Słowa na celowniku:** eksperci twierdzą, obserwatorzy zauważają, według doniesień, wiele źródeł podaje, powszechnie uważa się, jak wiadomo, analitycy wskazują (gdy brak konkretnego źródła)

**Problem:** AI przypisuje opinie mglistym autorytetom bez podania konkretnego źródła.

**PRZED:**
> Ze względu na swoje unikalne cechy rzeka budzi zainteresowanie badaczy. Eksperci uważają, że odgrywa kluczową rolę w regionalnym ekosystemie.

**PO:**
> Rzeka jest siedliskiem kilku endemicznych gatunków ryb - wynika z badania terenowego z 2019 roku.

### 6. Schematyczne sekcje „Wyzwania i perspektywy"

**Słowa na celowniku:** Pomimo... mierzy się z licznymi wyzwaniami, Mimo tych wyzwań, Wyzwania i perspektywy, Przyszłość i perspektywy rozwoju

**Problem:** Wiele tekstów AI ma sztampową sekcję „wyzwań" doklejoną na siłę.

**PRZED:**
> Pomimo przemysłowego rozwoju, dzielnica mierzy się z wyzwaniami typowymi dla obszarów miejskich, takimi jak korki i niedobór wody. Mimo tych wyzwań, dzięki dogodnemu położeniu i prowadzonym inicjatywom, wciąż się rozwija.

**PO:**
> Korki nasiliły się po 2015 roku, gdy otwarto trzy nowe parki biurowe. W 2022 roku gmina ruszyła z projektem kanalizacji deszczowej, żeby zaradzić powtarzającym się podtopieniom.

## WZORCE JĘZYKOWE I GRAMATYCZNE

### 7. Nadużywane „słownictwo AI"

**Wysokoczęstotliwościowe słowa AI (rozpoznawaj też formy odmienione):** kluczowy, istotny, znaczący, fundamentalny, przełomowy, niezwykle, wszechstronny, holistyczny, dynamiczny, innowacyjny, nieoceniony, bezcenny, fascynujący, imponujący, stanowi, podkreśla, odzwierciedla, przyczynia się do, odgrywa rolę, warto zauważyć / podkreślić, należy zauważyć / pamiętać, w kontekście, w dobie, w erze, w obliczu, realnie, dedykowany

**Częste frazy-klisze:** „w dzisiejszym dynamicznie zmieniającym się świecie", „nie sposób nie zauważyć, że", „w gąszczu / morzu informacji", „prawdziwa kopalnia wiedzy", „idzie w parze z", „na przestrzeni lat"

**Problem:** Wymienione słowa pojawiają się istotnie częściej w tekstach po 2023 roku. Często współwystępują - „kluczowy", „kluczową" i „kluczowego" to ten sam sygnał, nie trzy oddzielne. Pojedynczy przypadek nie jest jeszcze sygnałem; pięć w jednym akapicie to już znamię. Słowa „realnie" i „dedykowany" mają w tekstach AI nieproporcjonalnie wysoką frekwencję; same w sobie nie są błędem, lecz gdy pojawiają się automatycznie w kolejnych zdaniach, wskazują na generowanie maszynowe.

**PRZED:**
> W dzisiejszym dynamicznie zmieniającym się świecie kuchnia somalijska stanowi fascynujący przykład wszechstronności. Trwałym świadectwem wpływów włoskich jest powszechne przyjęcie makaronu, co odzwierciedla, jak dania te realnie wpisały się w lokalną tradycję.

**PO:**
> Kuchnia somalijska korzysta też z mięsa wielbłąda, uważanego za przysmak. Dania z makaronu, wprowadzone w czasach włoskiej kolonizacji, są nadal popularne, zwłaszcza na południu.

### 8. Unikanie „jest / to" (zastępowanie orzeczenia)

**Słowa na celowniku:** stanowi, pełni funkcję / rolę, odgrywa rolę, jawi się jako, prezentuje się, charakteryzuje się, może poszczycić się

**Problem:** AI podmienia proste „jest" albo „to" na rozbudowane konstrukcje. W polskim szczególnie razi nadużycie „stanowi". Pamiętaj, że polszczyzna często naturalnie opuszcza orzeczenie imienne („X to Y" bez „jest").

**PRZED:**
> Galeria 825 stanowi przestrzeń wystawienniczą dla sztuki współczesnej. Obiekt charakteryzuje się czterema osobnymi salami i może poszczycić się powierzchnią ponad 300 metrów kwadratowych.

**PO:**
> Galeria 825 to przestrzeń wystawiennicza dla sztuki współczesnej. Ma cztery sale o łącznej powierzchni 300 metrów kwadratowych.

### 9. Paralelizmy przeczące i doczepione przeczenia

**Problem:** Konstrukcje typu „Nie tylko..., ale...", „To nie tylko..., to..." są nadużywane. Podobnie urwane przeczenia doczepiane na końcu zdania („bez zgadywania", „bez zbędnego wysiłku") zamiast pełnego zdania. Osobny, wyraźnie polski wariant to seria zdań „Bez... Bez... Bez..." (charakterystyczna dla tekstów sprzedażowych i postów na LinkedIn): autor użyje tej konstrukcji raz dla podkreślenia, model generatywny powtarza ją przez pół akapitu.

**PRZED:**
> To nie tylko piosenka, to manifest. Nie chodzi tu jedynie o bit pod wokalem, chodzi o agresję i klimat.

**PO:**
> Ciężki bit wzmacnia agresywny ton utworu.

**PRZED (doczepione przeczenie / seria „bez"):**
> Konfigurujesz raz. Bez stresu. Bez wysiłku. Bez zgadywania.

**PO:**
> Konfigurujesz raz, a system nie zmusza cię do zgadywania ustawień.

### 10. Nadużycie reguły trzech

**Problem:** Model generatywny grupuje pomysły po trzy, tworząc wrażenie kompletności. Charakterystyczny jest też schemat całego tekstu: wstęp - trzy punkty - podsumowanie.

**PRZED:**
> Wydarzenie oferuje prelekcje, panele dyskusyjne i możliwości networkingu. Uczestnicy mogą liczyć na innowacje, inspirację i branżowe insighty.

**PO:**
> W programie są prelekcje i panele. Między nimi jest czas na swobodny networking.

### 11. Wariacja synonimiczna (krążenie po synonimach)

**Problem:** Modele generatywne mają wbudowany mechanizm karania powtórzeń, co prowadzi do nadmiernego podmieniania synonimów. Polszczyzna jest bogata synonimicznie, więc efekt bywa szczególnie wyraźny.

**PRZED:**
> Bohater mierzy się z wieloma trudnościami. Główna postać musi pokonać przeszkody. Centralna figura ostatecznie triumfuje. Protagonista wraca do domu.

**PO:**
> Bohater mierzy się z wieloma trudnościami, ale ostatecznie triumfuje i wraca do domu.

### 12. Fałszywe zakresy

**Problem:** AI używa konstrukcji „od X do Y" albo „począwszy od..., a skończywszy na...", gdzie X i Y nie leżą na żadnej sensownej skali.

**PRZED:**
> Nasza podróż przez wszechświat zabrała nas od osobliwości Wielkiego Wybuchu po kosmiczną sieć, od narodzin i śmierci gwiazd po enigmatyczny taniec ciemnej materii.

**PO:**
> Książka omawia Wielki Wybuch, powstawanie gwiazd i obecne teorie na temat ciemnej materii.

### 13. Strona bierna i zdania bez sprawcy

**Problem:** AI często ukrywa wykonawcę albo całkiem gubi podmiot: „Nie wymaga konfiguracji", „Wyniki są zapisywane automatycznie". Uwaga na polską specyfikę: formy nieosobowe na -no / -to (ustalono, wykonano) oraz konstrukcje z „się" są naturalne i często wręcz wskazane. Problemem nie jest sama bezosobowość, lecz ukrywanie sprawcy tam, gdzie strona czynna jest jaśniejsza i bardziej bezpośrednia.

**PRZED:**
> Plik konfiguracyjny nie jest wymagany. Wyniki są zapisywane automatycznie.

**PO:**
> Nie potrzebujesz pliku konfiguracyjnego. System zapisuje wyniki automatycznie.

## WZORCE STYLISTYCZNE

### 14. Myślnik i półpauza: ostrożnie (reguła inna niż w angielskim)

**Tło normatywne:** W polszczyźnie myślnik (pauza, —) i półpauza (–) to **prawidłowe znaki interpunkcyjne** - służą do wtrąceń, zawieszenia głosu, dialogów (pauza dialogowa) oraz oznaczania przedziałów (półpauza bez spacji: lata 1972–1975, trasa Wrocław–Poznań). Łącznik / dywiz (-) to z kolei znak ortograficzny, wewnątrzwyrazowy (polsko-czeski, Bielsko-Biała), a nie interpunkcyjny.

**Problem (specyfika AI):** W polskim tekście użytkowym, biznesowym i internetowym autorzy rzadko wstukują długi myślnik - jest niewygodny na klawiaturze. Jego częste użycie, szczególnie w rytmie angielskim (myślnik zamiast przecinka, dwukropka i kropki w każdym zdaniu), jest jednym z najsilniejszych sygnałów tekstu generowanego przez AI.

**Reguła domowa (styl Michała):** Wersja finalna nie zawiera długich myślników (— ani –). Każdy zastępuj, mniej więcej w tej kolejności: kropką (nowe zdanie), przecinkiem (ciasne wtrącenie), dwukropkiem (wprowadzenie wyjaśnienia), nawiasem (prawdziwe wtrącenie) albo przebuduj zdanie. Łapaj też myślniki ze spacjami (` — `) i podwójne łączniki (` -- `) użyte w tej samej funkcji. W tekstach elektronicznych dopuszczalny jest łącznik ze spacjami w funkcji myślnika, ale w pismach formalnych lepiej zdanie przebudować, niż podstawiać łącznik za myślnik.

**PRZED:**
> Termin promują głównie instytucje — nie sami zainteresowani. Nie mówi się „Holandia, Europa" jako adres — a jednak ta etykieta trwa — nawet w dokumentach urzędowych.

**PO:**
> Termin promują głównie instytucje, nie sami zainteresowani. Nikt nie podaje „Holandia, Europa" jako adresu, a mimo to etykieta trwa, nawet w dokumentach urzędowych.

Przed oddaniem wersji finalnej przeskanuj ją pod kątem `—` i `–`. Każde trafienie znaczy, że szkic nie jest gotowy.

### 15. Nadużycie pogrubień

**Problem:** AI mechanicznie pogrubia frazy.

**PRZED:**
> Łączy **OKR-y (cele i kluczowe rezultaty)**, **KPI (kluczowe wskaźniki efektywności)** oraz narzędzia wizualne, takie jak **Business Model Canvas (BMC)** i **Balanced Scorecard (BSC)**.

**PO:**
> Łączy OKR-y, KPI oraz narzędzia wizualne, takie jak Business Model Canvas i Balanced Scorecard.

### 16. Listy z pogrubionym nagłówkiem śródwierszowym

**Problem:** AI generuje listy, w których każdy punkt zaczyna się od pogrubionego nagłówka i dwukropka.

**PRZED:**
> - **Doświadczenie użytkownika:** Doświadczenie użytkownika zostało znacząco poprawione dzięki nowemu interfejsowi.
> - **Wydajność:** Wydajność wzrosła dzięki zoptymalizowanym algorytmom.
> - **Bezpieczeństwo:** Bezpieczeństwo wzmocniono szyfrowaniem end-to-end.

**PO:**
> Aktualizacja poprawia interfejs, przyspiesza działanie dzięki zoptymalizowanym algorytmom i dodaje szyfrowanie end-to-end.

### 17. Nagłówki z każdym słowem wielką literą (kalka angielska)

**Problem:** AI zapisuje nagłówki w stylu angielskim (Title Case), czyli z każdym znaczącym słowem od wielkiej litery. W polszczyźnie to błąd - w nagłówkach i tytułach wielką literą piszemy tylko pierwszy wyraz i nazwy własne. Ten sam mechanizm widać w hasztagach CamelCase (#TworzenieTreściSEO zamiast #tworzenietreściseo).

**PRZED:**
> ## Strategiczne Negocjacje I Globalne Partnerstwa

**PO:**
> ## Strategiczne negocjacje i globalne partnerstwa

### 18. Emoji

**Problem:** AI dekoruje nagłówki i punkty list emotkami, często co dwa-trzy zdania, niezależnie od tonu i tematu.

**PRZED:**
> 🚀 **Faza wdrożenia:** Produkt rusza w III kwartale
> 💡 **Kluczowy wniosek:** Użytkownicy wolą prostotę
> ✅ **Następne kroki:** Umówić spotkanie kontrolne

**PO:**
> Produkt rusza w III kwartale. Badania pokazały, że użytkownicy wolą prostotę. Następny krok: umówić spotkanie kontrolne.

### 19. Cudzysłów: polski „..." zamiast angielskiego (reguła odwrotna do angielskiej)

**Tło normatywne:** Podstawowy polski cudzysłów to cudzysłów apostrofowy „..." (otwierający na dole, zamykający u góry; Alt+0132 i Alt+0148). W cytacie wewnątrz cytatu używamy cudzysłowu ostrokątnego: niemieckiego »...« (ostrza do środka) albo francuskiego «...».

**Problem (specyfika AI):** Wersja angielska tego skilla każe zamieniać „kręcone" cudzysłowy na proste. W polskim jest odwrotnie - poprawny jest właśnie cudzysłów „kręcony" dolno-górny. Sygnałem AI (albo źle ustawionego edytora) jest cudzysłów angielski “...” lub ”...”, prosty maszynowy "..." (ten oznacza cale i sekundy) oraz błędna forma „...“ z dwoma znakami otwierającymi. Zamieniaj je na „...".

**PRZED:**
> Powiedział “projekt idzie zgodnie z planem”, ale inni się nie zgadzali.

**PO:**
> Powiedział „projekt idzie zgodnie z planem", ale inni się nie zgadzali.

**Cytat w cytacie:**
> Podaję treść notatki: „W mieszkaniu nie znaleziono nic poza dzisiejszym »Dziennikiem«".

## WZORCE KOMUNIKACYJNE

### 20. Artefakty rozmowy z asystentem

**Słowa na celowniku:** Mam nadzieję, że to pomoże, Oczywiście!, Jasne!, Świetne pytanie!, Masz całkowitą rację!, Czy chciałbyś..., Chcesz, żebym...?, Mam podać przykłady?, Mam kontynuować?, Daj znać, Oto...

**Problem:** Tekst pomyślany jako rozmowa z chatbotem zostaje wklejony jako treść.

**PRZED:**
> Oto przegląd rewolucji francuskiej. Mam nadzieję, że to pomoże! Daj znać, jeśli chciałbyś, żebym rozwinął którąś z sekcji.

**PO:**
> Rewolucja francuska zaczęła się w 1789 roku, gdy kryzys finansowy i braki żywności doprowadziły do powszechnych niepokojów.

### 21. Zastrzeżenia o dacie wiedzy i zmyślone wypełnianie luk

**Słowa na celowniku:** według mojej ostatniej aktualizacji, na dzień [data], choć dostępne informacje są ograniczone / skąpe, na podstawie dostępnych danych, nie są publicznie dostępne, ceni prywatność, stroni od rozgłosu, prawdopodobnie dorastał / studiował, przypuszcza się, że

**Problem:** Dwa powiązane sygnały. (a) Starsze modele zostawiają w tekście twarde zastrzeżenia o dacie wiedzy. (b) Gdy model nie znajduje źródła, pisze akapit *o tym*, że go nie znajduje, a potem dorabia prawdopodobnie brzmiące wypełniacze. Przy osobie prywatnej zgadywanka prawie zawsze ląduje na tych samych kliszach („ceni prywatność", „stroni od rozgłosu"), żadna bez źródła. Napisz, czego nie wiadomo, albo wytnij zdanie - nie ubieraj domysłu w fakt.

**PRZED (data wiedzy):**
> Choć szczegóły założenia firmy nie są dobrze udokumentowane w dostępnych źródłach, wydaje się, że powstała ona gdzieś w latach 90.

**PO:**
> Firmę założono w 1994 roku, zgodnie z dokumentami rejestrowymi.

**PRZED (zmyślone wypełnianie luki):**
> Informacje o jej wczesnym życiu nie są publicznie dostępne, co sugeruje, że ceni prywatność i stroni od rozgłosu. Prawdopodobnie dorastała w rodzinie z klasy średniej, co ukształtowało jej późniejsze zainteresowanie reformą edukacji.

**PO:**
> Wczesne życie bohaterki nie jest udokumentowane w dostępnych źródłach. (Albo pomiń tę część.)

### 22. Ton służalczy i nadgorliwie pochwalny

**Problem:** Przesadnie pozytywny, przypochlebny język.

**PRZED:**
> Świetne pytanie! Masz całkowitą rację, że to złożony temat. To doskonały punkt dotyczący czynników ekonomicznych.

**PO:**
> Wspomniane czynniki ekonomiczne są tu istotne.

## WYPEŁNIACZE I ASEKURACJA

### 23. Zwroty-wypełniacze i wielosłowie

**PRZED → PO:**
- „w celu osiągnięcia tego celu" → „aby to osiągnąć"
- „z uwagi na fakt, że padało" → „ponieważ padało"
- „w chwili obecnej" → „teraz" / „obecnie"
- „w przypadku, gdyby potrzebował pomocy" → „jeśli będzie potrzebował pomocy"
- „system posiada możliwość przetwarzania" → „system może przetwarzać"
- „należy zauważyć, że dane pokazują" → „dane pokazują"

**Pleonazmy do wycięcia:** „cofać się do tyłu", „kontynuować dalej", „w miesiącu maju", „okres czasu", „fakt autentyczny", „w pełni kompletny", „akwen wodny".

### 24. Nadmierna asekuracja

**Problem:** Przeładowanie zdania zastrzeżeniami. Słowa: potencjalnie, prawdopodobnie, niejako, poniekąd, w pewnym sensie, wydaje się, można przypuszczać.

**PRZED:**
> Można by potencjalnie argumentować, że polityka mogłaby mieć poniekąd pewien wpływ na wyniki.

**PO:**
> Polityka może wpłynąć na wyniki.

### 25. Ogólnikowe, optymistyczne zakończenia

**Problem:** Mgliste, podbudowujące finały.

**PRZED:**
> Przyszłość firmy rysuje się w jasnych barwach. Przed nami ekscytujące czasy w drodze ku doskonałości. To krok w dobrą stronę.

**PO:**
> Firma planuje otworzyć w przyszłym roku dwa kolejne oddziały.

### 26. Anglicyzmy i kalki z angielskiego (zastępuje angielski wzorzec łączników)

**Uwaga:** W wersji angielskiej ten punkt dotyczył nadużywania złożeń z łącznikiem (np. „data-driven"). W polszczyźnie takie złożenia nie powstają w ten sposób, więc punkt zastępujemy zjawiskiem realnie polskim - kalkami z angielskiego, które AI wnosi z anglojęzycznych źródeł.

**Słowa i frazy na celowniku:** dedykowany (w znaczeniu „przeznaczony / skierowany do"), adresować problem (od „to address"), w oparciu o (nadużywane zamiast „na podstawie"), na koniec dnia (od „at the end of the day"), to ma sens (od „it makes sense"), nie jestem przekonany do (od „I'm not sold on"), dostarczać wartość, być na tej samej stronie, hasztagi CamelCase

**Problem:** Modele generatywne tłumaczą angielskie schematy i idiomy dosłownie. Efektem są zdania poprawne gramatycznie, lecz brzmiące jak przekład, a nie jak tekst napisany pierwotnie po polsku. Dodatkowym zjawiskiem jest anglocentryzm kulturowy: odniesienia do Thanksgiving czy 4th of July w tekście skierowanym do polskiego odbiorcy.

**PRZED:**
> Przygotowaliśmy dedykowaną ofertę. Na koniec dnia chodzi o to, żeby dostarczać wartość w oparciu o dane - to po prostu ma sens.

**PO:**
> Przygotowaliśmy ofertę skierowaną do tej grupy. Najważniejsze jest, żeby dawać klientom realną wartość na podstawie danych.

### 27. Sztuczki „głębszej prawdy"

**Frazy na celowniku:** prawdziwe pytanie brzmi, w istocie, tak naprawdę, u podstaw leży, sedno sprawy, w gruncie rzeczy, głębszy problem

**Problem:** Model generatywny stosuje te zwroty, sygnalizując przejście do bardziej fundamentalnej analizy, podczas gdy zdanie następujące po nich zazwyczaj powtarza tę samą myśl z dodatkową pompą retoryczną.

**PRZED:**
> Prawdziwe pytanie brzmi, czy zespoły potrafią się dostosować. W istocie, tak naprawdę liczy się gotowość organizacyjna.

**PO:**
> Pytanie brzmi, czy zespoły potrafią się dostosować. To zależy głównie od tego, czy organizacja jest gotowa zmienić swoje nawyki.

### 28. Zapowiedzi i meta-komentarz

**Frazy na celowniku:** zanurzmy się, przyjrzyjmy się bliżej, rozłóżmy to na czynniki pierwsze, oto, co musisz wiedzieć, przejdźmy do, bez zbędnych ceregieli

**Problem:** Model generatywny zapowiada czynność zamiast ją wykonać. Ten meta-komentarz spowalnia tekst i nadaje mu charakter skryptu z poradnika.

**PRZED:**
> Zanurzmy się w to, jak działa buforowanie w Next.js. Oto, co musisz wiedzieć.

**PO:**
> Next.js buforuje dane na kilku poziomach: memoizacja żądań, cache danych i cache routera.

### 29. Nagłówki-atrapy

**Sygnał:** Nagłówek, po którym następuje jednozdaniowy akapit po prostu powtarzający nagłówek, zanim zacznie się właściwa treść.

**Problem:** Model generatywny często dokleja po nagłówku zdanie ogólne pełniące rolę retorycznej rozgrzewki. Zazwyczaj nie wnosi ono żadnej treści i powoduje, że tekst niepotrzebnie się rozrasta.

**PRZED:**
> ## Wydajność
>
> Szybkość ma znaczenie.
>
> Gdy użytkownik trafi na wolną stronę, ucieka.

**PO:**
> ## Wydajność
>
> Gdy użytkownik trafi na wolną stronę, ucieka.

### 30. Pisanie „od zmiany", a nie od stanu

**Problem:** Dokumentacja albo komentarze pisane tak, jakby relacjonowały zmianę, zamiast opisywać rzecz taką, jaka jest. Jeśli dokument nie jest z natury wersjonowany (changelog, informacje o wydaniu, przewodnik migracji), powinien być zrozumiały bez wiedzy o tym, co zmieniono w ostatnim commicie.

**PRZED:**
> Tę funkcję dodano, aby zastąpić poprzednie podejście iterujące po wszystkich elementach, które dawało złożoność O(n²).

**PO:**
> Funkcja korzysta z mapy haszującej i wyszukuje w czasie O(1), unikając kosztu O(n²) naiwnej iteracji.

### 31. Sztuczne puenty i dramat na krótkich zdaniach

**Problem:** Model generatywny konstruuje zdania tak, by każde kończyło się jak aforyzm, a następnie zestawia serię krótkich zdań oznajmujących dla uzyskania efektu dramatycznego. Pojedyncze krótkie zdanie dla podkreślenia myśli jest uzasadnione; seria fragmentów ustawionych jeden po drugim to zabieg mechaniczny. (Por. punkt 9 - seria „bez... bez... bez...")

**PRZED:**
> A potem przyszedł nowy model. Bez upodobania do symetrii. Bez estetycznych uprzedzeń. Bez sentymentu do ludzkiego gustu. Stare reguły przestały obowiązywać.

**PO:**
> Nowy model zmienił sposób poszukiwań, bo nie faworyzował symetrii ani rozwiązań wyglądających „po ludzku". Część dawnych założeń straciła przez to znaczenie.

### 32. Aforyzmy z formułki

**Słowa na celowniku:** X to Y Z (np. „dane to ropa naftowa XXI wieku"), X jest językiem Y, waluta przyszłości, DNA marki, święty Graal, X to nie narzędzie, lecz lustro

**Problem:** Model generatywny przekształca zwykłe twierdzenia w gotowe aforyzmy, które brzmią głęboko, lecz niczego nie precyzują. Należy zastąpić formułkę konkretnym twierdzeniem, do którego zmierza.

**PRZED:**
> Symetria to język zaufania. Efektywność staje się pułapką, gdy zespoły zapominają o warstwie ludzkiej.

**PO:**
> Symetryczne układy często wydają się użytkownikom bardziej przewidywalne. Zespoły potrafią nadmiernie optymalizować procesy i przeoczyć, jak ludzie naprawdę z nich korzystają.

### 33. Rozmowne otwarcia retoryczne

**Frazy na celowniku:** Szczerze?, Słuchaj, Powiem wprost, Powiedzmy sobie szczerze, Umówmy się, Prawda jest taka, Co ważne - użyte jako samodzielne haczyki albo udawane pauzy „na szczerość" przed zwykłą myślą.

**Problem:** Model generatywny otwiera tekst pozorowanym sygnałem szczerości, by wytworzyć poczucie bliskości przed dostarczeniem rutynowego twierdzenia. Symptomem jest teatralna pauza: jednowyrazowe pytanie lub wtrącenie, a następnie właściwa odpowiedź. Autor piszący szczerze po prostu formułuje myśl bez wstępu.

**PRZED:**
> Czy warto tyle płacić? Szczerze? To zależy, jak często będziesz tego używał.

**PO:**
> To, czy warto tyle płacić, zależy od tego, jak często będziesz tego używał.

## WSKAZÓWKI DETEKCYJNE

### Czego NIE oznaczać (fałszywe alarmy)

Sprawny autor może trafić w kilka powyższych wzorców bez żadnego udziału modelu generatywnego. Przed przepisaniem warto ocenić na chłodno, czy nie ingeruje się w dobrą prozę. Wymienione niżej cechy same w sobie nie są wiarygodnymi sygnałami:

- **Poprawna gramatyka i spójny styl.** Wielu autorów to profesjonaliści albo teksty przeszły redakcję. Poprawność to nie AI. Dotyczy to zwłaszcza prawnika - pismo bez błędów to norma zawodowa, nie podejrzenie.
- **Formalne i urzędowe słownictwo.** Rejestr prawniczy i urzędowy ma własne konwencje. Nie spłaszczaj „niniejszym", „zważywszy", „w związku z powyższym", „mając na uwadze" tylko dlatego, że brzmią oficjalnie. To nie jest tekst do uczłowieczania.
- **Polski cudzysłów „...".** Sam w sobie to nie sygnał AI, tylko poprawna polszczyzna. Podejrzany jest dopiero cudzysłów angielski “...” albo prosty "..." w polskim tekście (patrz punkt 19).
- **Pojedynczy myślnik w dialogu albo wtrąceniu.** To normalna polszczyzna. Sygnałem jest dopiero nadużycie w angielskim rytmie. Zarazem pamiętaj: w tekście biznesowym i internetowym częsty długi myślnik jest realnym sygnałem, bo polscy autorzy rzadko go wstukują (patrz punkt 14).
- **Pojedyncze słowa-łączniki.** „Jednak", „ponadto", „co więcej", „w związku z tym" są kodowane jako AI dopiero spiętrzone. Jedno „jednak" to nie sygnał.
- **Mieszanie rejestru potocznego i formalnego.** Często znaczy to, że pisze osoba z branży technicznej albo młodszy autor, a nie chatbot.
- **„Nijaka" albo „sucha" proza.** Tekst AI ma *konkretne* sygnały. Ogólna oschłość bez tych sygnałów to po prostu suche pisanie.
- **Twierdzenia bez źródeł.** Większość sieci jest bez przypisów. Brak cytowań niczego nie dowodzi.
- **Pojedyncze krótkie, dobitne zdanie.** Ludzie używają urwanych zdań, żeby podkreślić myśl. Dramat na krótkich zdaniach oznaczaj tylko wtedy, gdy seria fragmentów idzie jeden po drugim i nadyma ton.
- **Poprawne, złożone formatowanie.** Edytory wizualne i szablony dają czysty efekt bez żadnego AI.

W razie wątpliwości należy szukać **skupisk** sygnałów, nie pojedynczych przypadków. Jeden myślnik nic nie przesądza. Myślnik plus reguła trzech plus „stanowi fascynujący przykład" plus sekcja „Podsumowując" - to zestaw wystarczający do identyfikacji.

### Oznaki tekstu napisanego przez człowieka (te zachowaj)

Gdy poniższe cechy są obecne, tekst warto pozostawić bez większej ingerencji - to sygnały autentycznego autorstwa, a nadmierna redakcja może zniszczyć to, co czyni go oryginalnym:

- **Konkretny, nieoczywisty, trudny do zmyślenia szczegół.** Prawdziwy adres. Nieoczekiwany cytat. Sformułowanie w rodzaju „prawnik, który przez lata urzędował nad gabinetem mojego dentysty". Modele generatywne zaokrąglają konkrety, autorzy je gromadzą.
- **Ambiwalencja i nierozstrzygnięte napięcie.** „W zasadzie jest dobrze, ale coś mi w tym nie pasuje i nie umiem tego nazwać." Model generatywny domyślnie formułuje czyste tezy.
- **Polskie realia i lokalny kontekst.** Opole, nie Ohio. Konkretne polskie miejsca, urzędy, marki, wydarzenia. Brak tego kontekstu (Thanksgiving, 4th of July w tekście adresowanym do polskiego odbiorcy) jest sygnałem generowania maszynowego.
- **Polskie idiomy i frazeologizmy użyte naturalnie**, a nie kalki z angielskiego.
- **Odniesienia osadzone w konkretnym czasie.** Slang, nawiązania do aktualnych wydarzeń, żarty wewnętrzne powiązane z danym rokiem i środowiskiem. Modele generatywne są opóźnione o rok lub więcej.
- **Zróżnicowana długość zdań.** Autentyczny tekst miesza zdania krótkie i długie. Modele generatywne wykazują tendencję do wyrównanego, średniego rytmu.
- **Prawdziwe dygresje, wtrącenia w nawiasach i autopoprawki.** „(Ciągle chcę napisać »prawie«, ale to naprawdę było pewne.)" Modele generatywne rzadko same sobie przerywają.
- **Drobne potknięcia i kolokwializmy.** Autentyczny tekst bywa nierówny, miejscami niezgrabny, ale wiarygodny.

## Proces i wynik

1. Przeczytaj tekst uważnie i zidentyfikuj każde wystąpienie powyższych wzorców.
2. Przygotuj **szkic przepisania**. Sprawdź, czy tekst czyta się naturalnie, czy różnicuje długość zdań, czy operuje na konkretnych szczegółach i prostych konstrukcjach (jest / to / ma) oraz czy zachowuje właściwy rejestr.
3. Odpowiedz krótko na pytanie: **„Co w tym tekście wskazuje na generowanie maszynowe?"** - wskazując sygnały, które nadal są widoczne.
4. Doprowadź do **wersji finalnej**, która te sygnały usuwa i nie zawiera długich myślników (— ani –; por. punkt 14).

Dostarcz: szkic, krótkie punkty „co wciąż brzmi jak AI", wersję finalną oraz (opcjonalnie) krótkie podsumowanie zmian.

## Pełny przykład

**PRZED (brzmi jak AI):**
> Świetne pytanie! Oto artykuł na ten temat. Mam nadzieję, że pomoże!
>
> W dzisiejszym dynamicznie zmieniającym się świecie sztuczna inteligencja stanowi przełomowe narzędzie, które odgrywa kluczową rolę w transformacji sposobu, w jaki tworzymy treści — rewolucjonizując branżę i wyznaczając nowy kierunek. U podstaw leży jasna obietnica: usprawnienie procesów, zwiększenie efektywności i budowanie zaangażowania. To nie tylko autouzupełnianie — to uwalnianie kreatywności na niespotykaną skalę.
>
> Eksperci podkreślają, że adopcja przyspieszyła z eksperymentów hobbystów do wdrożeń w całych organizacjach. Według badań aż 78% firm dostrzega realne korzyści. Technologia była szeroko opisywana w prestiżowych mediach.
>
> - 💡 **Szybkość:** Generowanie treści jest znacząco szybsze.
> - 🚀 **Jakość:** Jakość uległa poprawie dzięki ulepszonym modelom.
> - ✅ **Adopcja:** Wykorzystanie stale rośnie.
>
> Choć dostępne informacje są ograniczone, można potencjalnie argumentować, że narzędzia te mogłyby mieć pewien pozytywny wpływ. Pomimo wyzwań typowych dla nowych technologii, ekosystem wciąż się rozwija.
>
> Podsumowując, przyszłość rysuje się w jasnych barwach. Przed nami ekscytujące czasy. Daj znać, jeśli chciałbyś, żebym rozwinął którąś z sekcji!

**Szkic przepisania:**
> Asystenty AI przyspieszają część zadań przy pisaniu. W badaniu Google z 2024 roku programiści korzystający z modelu kończyli proste funkcje o 55% szybciej niż grupa kontrolna, ale nie zyskiwali na debugowaniu ani decyzjach architektonicznych.
>
> Narzędzia są dobre w pracy szablonowej: pliki konfiguracyjne, rusztowanie testów, powtarzalne refaktoryzacje. Są słabe w rozpoznawaniu, kiedy się mylą. Akceptowałem hurtem podpowiedzi, które się kompilowały, przechodziły lintera i dalej robiły nie to, bo przestałem uważać.
>
> Rozmówcy dzielą się na dwa obozy. Jedni używają tego jak autouzupełniania do nudnej roboty i sprawdzają każdą linię. Drudzy wyłączają funkcję, gdy podsuwa wzorce, których nie chcą. Oba podejścia są rozsądne.
>
> Deklaracje o produktywności trudno zweryfikować. Producent może podawać, że użytkownicy akceptują 30% podpowiedzi, ale akceptacja to nie poprawność, a poprawność to nie wartość. Bez testów po prostu zgadujesz.

**Co wciąż wskazuje na tekst generowany maszynowo:**
- Rytm jest miejscami zbyt równy (symetryczne kontrasty, równo wyważone akapity).
- Przywołane badanie może sprawiać wrażenie wiarygodnego, lecz bez podanego źródła jest domniemaniem.
- Zakończenie ma charakter sloganowy („Bez testów...") zamiast autentycznej konkluzji.

**Wersja finalna:**
> Asystenty AI potrafią cię przyspieszyć w nudnych fragmentach. Nie we wszystkim. Na pewno nie w architekturze.
>
> Świetnie radzą sobie z szablonem: pliki konfiguracyjne, rusztowanie testów, powtarzalne refaktoryzacje. Świetnie też brzmią słusznie, gdy są w błędzie. Akceptowałem podpowiedzi, które się kompilowały, przechodziły lintera i mijały się z sensem, bo przestałem uważać.
>
> Ludzie, z którymi rozmawiam, dzielą się na dwa obozy. Jedni traktują to jak autouzupełnianie do roboty na chwilę i sprawdzają każdą linię. Drudzy wyłączają funkcję, gdy uparcie podsuwa to, czego nie chcą. Jedno i drugie ma sens.
>
> Liczby o produktywności są śliskie. Producent powie, że użytkownicy akceptują 30% podpowiedzi, tylko akceptacja to nie poprawność, a poprawność to nie wartość. Bez testów zgadujesz.

**Wprowadzone zmiany:** Usunięto ramkę konwersacji z asystentem, nadymanie znaczenia, język promocyjny i doczepki imiesłowowe, regułę trzech i wariację synonimiczną, paralelizm przeczący „to nie tylko... to...", statystykę bez źródła, mgliste „eksperci podkreślają", zastępowanie „jest / to" rozbudowanymi konstrukcjami, myślniki, emoji, mechaniczne pogrubienia, schematyczną sekcję „wyzwań", asekurację i zastrzeżenie o dacie wiedzy, wypełniacze oraz ogólnikowe optymistyczne zakończenie. Tekst odbudowano, różnicując rytm zdań i wprowadzając konkretne obserwacje.

## Źródła

Adaptacja językowa opiera się na polskich źródłach normatywnych i obserwacjach praktyków:

- **Poradnia Językowa PWN** (sjp.pwn.pl/poradnia) - hasła o myślniku, półpauzie i łączniku oraz o cudzysłowach pierwszego i drugiego stopnia.
- **Wielki słownik ortograficzny PWN** (red. E. Polański) oraz **Nowy słownik poprawnej polszczyzny PWN** (red. A. Markowski) - zasady interpunkcji i pisowni.
- **Rada Języka Polskiego** - rozstrzygnięcia dotyczące rodzajów kresek (pauza, półpauza, dywiz).
- Obserwacje znamion polskiego tekstu AI zebrano m.in. z polskich poradników o rozpoznawaniu treści z ChatGPT, Claude i Gemini oraz z polskojęzycznych detektorów tekstu AI (analiza nadużywanych fraz, słownictwa i interpunkcji w polszczyźnie).

Kluczowa różnica względem wersji angielskiej: reguły dotyczące cudzysłowu i myślnika działają w polszczyźnie częściowo odwrotnie (poprawny jest cudzysłów „..." i istnieje legalny myślnik interpunkcyjny), a angielski wzorzec złożeń z łącznikiem zastąpiono polskim problemem anglicyzmów i kalek.
