
create or replace function create_new_season(season_name text)
returns json
language plpgsql
security definer
as $$
declare
  new_season seasons;
begin
  -- Set all existing seasons to not current
  update seasons set is_current = false;
  
  -- Create new season as current
  insert into seasons (name, is_current)
  values (season_name, true)
  returning * into new_season;
  
  return json_build_object(
    'id', new_season.id,
    'name', new_season.name,
    'isCurrent', new_season.is_current,
    'createdAt', new_season.created_at,
    'biome', new_season.biome,
    'updatedAt', new_season.updated_at
  );
end;
$$;