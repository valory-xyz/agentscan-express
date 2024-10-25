
create type character_status as enum ('active', 'eliminated');

create table if not exists characters (
  id uuid default gen_random_uuid() primary key,
  name varchar(255) not null,
  description text,
  image_url text not null,
  status character_status default 'active',
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

-- Add index for status queries
create index characters_status_idx on characters(status);

-- Add trigger for updated_at
create or replace function update_updated_at_column()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger characters_updated_at
  before update on characters
  for each row
  execute function update_updated_at_column();