

-- Create a function to check if characters can be created
create or replace function can_create_character()
returns trigger as $$
declare
    season_status record;
begin
    -- Get the current season status
    select is_current, is_playing
    into season_status
    from seasons
    where id = new.season_id;

    -- If the season is current and playing, prevent creation
    if season_status.is_current and season_status.is_playing then
        raise exception 'Cannot create characters while the current season is in play';
    end if;

    return new;
end;
$$ language plpgsql;

-- Add trigger to check before character creation
create trigger check_character_creation
    before insert on characters
    for each row
    execute function can_create_character();

-- Create a function to manage season state
create or replace function manage_season_state()
returns trigger as $$
begin
    -- If setting a season as current, update all other seasons
    if new.is_current and old.is_current = false then
        update seasons
        set is_current = false
        where id != new.id;
    end if;

    -- If setting a season as not current, ensure it's not playing
    if new.is_current = false and new.is_playing = true then
        new.is_playing = false;
    end if;

    return new;
end;
$$ language plpgsql;

-- Add trigger for season state management
create trigger manage_season_state_trigger
    before update on seasons
    for each row
    execute function manage_season_state();

-- Update the season API function to include is_playing
create or replace function get_current_season()
returns jsonb as $$
declare
    current_season record;
begin
    select *
    into current_season
    from seasons
    where is_current = true
    limit 1;

    if not found then
        return null;
    end if;

    return jsonb_build_object(
        'id', current_season.id,
        'name', current_season.name,
        'isCurrent', current_season.is_current,
        'isPlaying', current_season.is_playing,
        'createdAt', current_season.created_at,
        'updatedAt', current_season.updated_at
    );
end;
$$ language plpgsql;