create table if not exists seasons (
  id uuid default gen_random_uuid() primary key,
  name varchar(255) not null,
  is_current boolean default false,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

-- Add constraint to ensure only one current season
create unique index seasons_current_idx on seasons (is_current) where is_current = true;

-- Add season_id to characters table
alter table characters add column season_id uuid references seasons(id);
create index characters_season_idx on characters(season_id);

-- Add trigger for seasons updated_at
create trigger seasons_updated_at
  before update on seasons
  for each row
  execute function update_updated_at_column();