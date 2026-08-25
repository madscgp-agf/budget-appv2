-- ============================================================
--  Toget — deling mellem to personer
--  Kør i Supabase: SQL Editor -> New query -> indsæt -> Run.
--  Kan køres igen uden at ødelægge data.
--
--  Husstanden gemmes som ét dokument. Appen har i forvejen én
--  samlet tilstand, og to personer redigerer sjældent det samme
--  sekund; klienten fletter pr. post og prøver igen ved sammenstød.
-- ============================================================

create extension if not exists pgcrypto;

create table if not exists husstande (
  id        uuid primary key default gen_random_uuid(),
  navn      text not null default 'Vores husstand',
  kode      text not null unique,                 -- invitationskode, fx "GROEN-HAVRE-42"
  doc       jsonb not null default '{}'::jsonb,   -- madplan, indkøbsliste, udgifter, opsætning
  version   bigint not null default 1,
  opdateret timestamptz not null default now(),
  oprettet  timestamptz not null default now()
);

create table if not exists medlemmer (
  husstand_id uuid not null references husstande(id) on delete cascade,
  bruger_id   uuid not null references auth.users(id) on delete cascade,
  navn        text not null default 'Mig',
  rolle       text not null default 'medlem' check (rolle in ('ejer','medlem')),
  tilmeldt    timestamptz not null default now(),
  primary key (husstand_id, bruger_id)
);
create index if not exists idx_medlemmer_bruger on medlemmer(bruger_id);

-- To personer pr. husstand. Det er en parapp, ikke et regnskabssystem.
create or replace function tjek_to_medlemmer() returns trigger
language plpgsql security definer as $$
begin
  if (select count(*) from medlemmer where husstand_id = new.husstand_id) >= 2 then
    raise exception 'Der kan kun være to personer i en husstand';
  end if;
  return new;
end $$;

drop trigger if exists medlemmer_maks_to on medlemmer;
create trigger medlemmer_maks_to before insert on medlemmer
  for each row execute function tjek_to_medlemmer();

-- ============================================================
--  Row Level Security: man ser kun sin egen husstand
-- ============================================================
alter table husstande enable row level security;
alter table medlemmer enable row level security;

-- Uden security definer ville politikken på medlemmer slå sig selv op i en løkke.
create or replace function mine_husstande() returns setof uuid
language sql security definer stable as $$
  select husstand_id from medlemmer where bruger_id = auth.uid()
$$;

drop policy if exists husstand_laes on husstande;
create policy husstand_laes on husstande for select
  using (id in (select mine_husstande()));

-- Man må oprette en husstand; man bliver først medlem i næste kald.
drop policy if exists husstand_opret on husstande;
create policy husstand_opret on husstande for insert
  to authenticated with check (true);

drop policy if exists husstand_ret on husstande;
create policy husstand_ret on husstande for update
  using (id in (select mine_husstande()))
  with check (id in (select mine_husstande()));

drop policy if exists medlem_laes on medlemmer;
create policy medlem_laes on medlemmer for select
  using (husstand_id in (select mine_husstande()) or bruger_id = auth.uid());

drop policy if exists medlem_tilmeld on medlemmer;
create policy medlem_tilmeld on medlemmer for insert
  with check (bruger_id = auth.uid());

drop policy if exists medlem_ret on medlemmer;
create policy medlem_ret on medlemmer for update using (bruger_id = auth.uid());

drop policy if exists medlem_forlad on medlemmer;
create policy medlem_forlad on medlemmer for delete using (bruger_id = auth.uid());

-- ============================================================
--  Slå en invitationskode op uden at kunne læse husstandens data
-- ============================================================
create or replace function find_husstand(p_kode text)
returns table (id uuid, navn text, antal int)
language sql security definer stable as $$
  select h.id, h.navn, (select count(*)::int from medlemmer m where m.husstand_id = h.id)
  from husstande h
  where upper(h.kode) = upper(trim(p_kode))
$$;

revoke all on function find_husstand(text) from public, anon;
grant execute on function find_husstand(text) to authenticated;

-- Gem-tidspunkt sættes af databasen, ikke af telefonens ur.
create or replace function saet_opdateret() returns trigger
language plpgsql as $$
begin
  new.opdateret = now();
  return new;
end $$;

drop trigger if exists husstande_opdateret on husstande;
create trigger husstande_opdateret before update on husstande
  for each row execute function saet_opdateret();
