# Deling mellem to telefoner — sådan sætter I det op

Det tager omkring fem minutter, og I skal kun gøre det én gang.

## 1. Opret databasen (dig, én gang)

1. Gå til [supabase.com](https://supabase.com) → **Start your project** → log ind med GitHub.
2. **New project**. Vælg et navn, en adgangskode til databasen (gem den et sikkert sted)
   og regionen **Frankfurt (eu-central-1)** — tættest på Danmark. Vent et minut.
3. Kør skemaet. **Fra telefonen er det nemmest inde fra appen:**
   **Indstillinger → Din partner → Kør skemaet i Supabase** → *Kopiér skemaet* →
   *Åbn SQL Editor* → hold fingeren i feltet, vælg **Sæt ind**, tryk **Run**.
   Fra en computer kan du i stedet indsætte
   [`supabase/schema.sql`](../supabase/schema.sql) manuelt.
   Der skal stå *Success. No rows returned*.
4. Åbn **Project Settings → API**. Her ligger de to værdier, appen skal bruge:
   - **Project URL** (`https://xxxxxxxx.supabase.co`)
   - **anon public** nøglen (den lange tekst under *Project API keys*)

Den anon-nøgle er lavet til at ligge i en app. Det er Row Level Security i skemaet,
der bestemmer hvad man må se — og der er kun adgang til den husstand, man selv er med i.

## 2. Slå mailbekræftelse fra (valgfrit, men nemmest)

**Authentication → Sign In / Providers → Email** → slå **Confirm email** fra.
Så kan I logge ind med det samme. Lader I den stå til, skal I bekræfte via en mail først.

## 3. Forbind appen (begge telefoner)

Projektet er allerede lagt ind i appen, så I skal ikke taste URL og nøgle.

1. Åbn appen → **Indstillinger → Din partner → Test forbindelsen**.
   Den svarer punkt for punkt, om alt er på plads.
2. **Log ind eller opret bruger.** I skal have **hver jeres** mail og adgangskode —
   ikke den samme bruger på begge telefoner.
3. På din telefon: **Opret husstand**. Du får en kode, fx `VARM-HAVRE-81`.
4. På hendes telefon: **Jeg har en kode** → indtast koden.

Derefter deler I madplan, indkøbsliste, budget og opsparing. Krydser hun mælk af i
Netto, står det på din skærm inden for få sekunder.

## Hvad der sker under motorhjelmen

- Husstanden gemmes som ét dokument med et versionsnummer. Gemmer I samtidig, opdager
  appen det og **fletter** i stedet for at lade den ene overskrive den anden: har I rørt
  hver sin ting, beholdes begge.
- Appen virker uden net. Rettelser lægges op, når forbindelsen er der igen.
- Der kan kun være **to** personer i en husstand — det er en parapp.

## 4. Luk døren efter jer

Nøglen i appen er offentlig med vilje — det er Row Level Security, der beskytter
jeres data. Men så længe tilmelding er åben, kan en fremmed oprette en bruger i
projektet (uden at kunne se noget som helst af jeres).

Når I begge har jeres login, så slå det fra:
**Authentication → Sign In / Providers → Email → "Allow new users to sign up"** fra.

Og hvis nøglen en dag skal skiftes: **Project Settings → API Keys** kan lave en ny
publishable-nøgle. Så skal den blot opdateres ét sted i `app/sky.js`.
