alter table public.notifications add column supervisor_only boolean not null default false;
CREATE OR REPLACE FUNCTION public.create_request_notification()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  date_text text;
  helper_team text;
  v_recipient_teams text[];
begin

  -- =========================
  -- INSERT
  -- =========================
  if tg_op = 'INSERT' then

    date_text := to_char(
      new.shift_date,
      'FMMM"월 "FMDD"일"'
    );

    -- 휴무 등록
    if new.status = 'OPEN'
       and coalesce(new.reason, '') <> '지정 대근' then

      helper_team := public._suggested_helper_team(
        new.team,
        new.shift_type,
        new.shift_date
      );

      v_recipient_teams := public._notification_recipient_teams(
        new.team,
        new.shift_type,
        new.shift_date
      );

      insert into public.notifications(
        event_type,
        title,
        body,
        request_id,
        recipient_teams,
        supervisor_only
      )
      values (
        'off_registered',
        case when new.request_kind = 'support' then '추가 지원 요청' else '휴무 등록' end,
        date_text
          || ' '
          || new.team
          || '조 '
          || case when new.request_kind = 'support'
               then coalesce(nullif(btrim(new.reason), ''), '지원') || ' 추가 지원을 요청하였습니다. 대근조는 '
               else new.requested_by || '님이 휴무를 등록하였습니다. 대근조는 '
             end
          || coalesce(helper_team, '확인 필요')
          || ' 입니다.',
        new.id,
        v_recipient_teams,
        ((new.team, btrim(coalesce(new.requested_by,''))) in (('A','임병철'),('B','백승학'),('C','김철종'),('D','주영훈')) or btrim(coalesce(new.filled_by,'')) in ('임병철','백승학','김철종','주영훈'))
      );


    -- 대근 등록
    elsif new.status = 'FILLED'
          and new.filled_by is not null then

      v_recipient_teams := public._notification_recipient_teams(
        new.team,
        new.shift_type,
        new.shift_date
      );

      insert into public.notifications(
        event_type,
        title,
        body,
        request_id,
        recipient_teams,
        supervisor_only
      )
      values (
        'sub_registered',
        '대근 등록',
        case when coalesce(new.request_kind, 'off') = 'off'
                  and coalesce(new.reason, '') <> '지정 대근'
             then date_text || '에 ' || new.requested_by || '(' || new.shift_type || ')'
                  || '님이 등록한 휴무의 대근자는 ' || new.filled_by || '님입니다.'
             else date_text
          || ' '
          || new.team
          || '조 대근이 등록되었습니다. '
          || new.filled_by
          || '님이 대근합니다.'
           end,
        new.id,
        v_recipient_teams,
        ((new.team, btrim(coalesce(new.requested_by,''))) in (('A','임병철'),('B','백승학'),('C','김철종'),('D','주영훈')) or btrim(coalesce(new.filled_by,'')) in ('임병철','백승학','김철종','주영훈'))
      );

    end if;

    return new;
  end if;


  -- =========================
  -- UPDATE
  -- =========================
  if tg_op = 'UPDATE' then

    date_text := to_char(
      new.shift_date,
      'FMMM"월 "FMDD"일"'
    );

    -- 대근 등록
    if old.status is distinct from 'FILLED'
       and new.status = 'FILLED'
       and new.filled_by is not null then

      v_recipient_teams := public._notification_recipient_teams(
        new.team,
        new.shift_type,
        new.shift_date
      );

      insert into public.notifications(
        event_type,
        title,
        body,
        request_id,
        recipient_teams,
        supervisor_only
      )
      values (
        'sub_registered',
        '대근 등록',
        case when coalesce(new.request_kind, 'off') = 'off'
                  and coalesce(new.reason, '') <> '지정 대근'
             then date_text || '에 ' || new.requested_by || '(' || new.shift_type || ')'
                  || '님이 등록한 휴무의 대근자는 ' || new.filled_by || '님입니다.'
             else date_text
          || ' '
          || new.team
          || '조 대근이 등록되었습니다. '
          || new.filled_by
          || '님이 대근합니다.'
           end,
        new.id,
        v_recipient_teams,
        ((new.team, btrim(coalesce(new.requested_by,''))) in (('A','임병철'),('B','백승학'),('C','김철종'),('D','주영훈')) or btrim(coalesce(new.filled_by,'')) in ('임병철','백승학','김철종','주영훈'))
      );


    -- 대근 취소
    elsif old.status = 'FILLED'
          and new.status = 'OPEN' then

      v_recipient_teams := public._notification_recipient_teams(
        new.team,
        new.shift_type,
        new.shift_date
      );

      insert into public.notifications(
        event_type,
        title,
        body,
        request_id,
        recipient_teams,
        supervisor_only
      )
      values (
        'sub_cancelled',
        '대근 취소',
        date_text || ' 대근이 취소되었습니다.',
        new.id,
        v_recipient_teams,
        ((new.team, btrim(coalesce(new.requested_by,''))) in (('A','임병철'),('B','백승학'),('C','김철종'),('D','주영훈')) or btrim(coalesce(new.filled_by,'')) in ('임병철','백승학','김철종','주영훈'))
      );

    end if;

    return new;
  end if;


  -- =========================
  -- DELETE
  -- =========================
  if tg_op = 'DELETE' then

    date_text := to_char(
      old.shift_date,
      'FMMM"월 "FMDD"일"'
    );

    v_recipient_teams := public._notification_recipient_teams(
      old.team,
      old.shift_type,
      old.shift_date
    );

    insert into public.notifications(
      event_type,
      title,
      body,
      request_id,
      recipient_teams,
      supervisor_only
    )
    values (
      'off_cancelled',
      case when old.request_kind = 'support' then '추가 지원 취소' else '휴무 취소' end,
      date_text || case when old.request_kind = 'support' then ' 추가 지원 요청이 취소되었습니다.' else ' 휴무가 취소되었습니다.' end,
      old.id,
      v_recipient_teams,
      ((old.team, btrim(coalesce(old.requested_by,''))) in (('A','임병철'),('B','백승학'),('C','김철종'),('D','주영훈')) or btrim(coalesce(old.filled_by,'')) in ('임병철','백승학','김철종','주영훈'))
    );

    return old;
  end if;


  return coalesce(new, old);

end;
$function$
