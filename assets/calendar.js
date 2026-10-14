// Memo slots are shared by all seven dates in a week; each team owns its own slot.
function memoSlotKey(m){return m.owner_team?'team:'+m.owner_team:'legacy:'+String(m.id);}
function memoSlotsForWeek(date,data){
  const start=weekStart(date),end=new Date(start);end.setDate(end.getDate()+7);
  const from=localDateKey(start),until=localDateKey(end),slots=new Map();
  for(const m of data.filter(m=>m.date>=from&&m.date<until).sort((a,b)=>String(a.id).padStart(24,'0').localeCompare(String(b.id).padStart(24,'0')))){
    const key=memoSlotKey(m);if(!slots.has(key))slots.set(key,{key,team:m.owner_team||null});
  }
  return slots.size?[...slots.values()]:[{key:'empty',team:null}];
}

  let HOLIDAYS = {

    "2026-01-01": "신정",

    "2026-02-16": "설연휴",
    "2026-02-17": "설날",
    "2026-02-18": "설연휴",

    "2026-03-01": "3·1절",

    "2026-05-05": "어린이날",
    "2026-05-24": "부처님오신날",
    "2026-06-06": "현충일",

    "2026-08-15": "광복절",

    "2026-09-24": "추석연휴",
    "2026-09-25": "추석",
    "2026-09-26": "추석연휴",

    "2026-10-03": "개천절",
    "2026-10-09": "한글날",
    "2026-12-25": "성탄절",

    "2027-01-01": "신정",

    "2027-02-06": "설연휴",
    "2027-02-07": "설날",
    "2027-02-08": "설연휴",
    "2027-02-09": "대체휴무",

    "2027-03-01": "3·1절",
    "2027-05-05": "어린이날",
    "2027-05-13": "부처님오신날",
    "2027-06-06": "현충일",

    "2027-08-15": "광복절",

    "2027-09-14": "추석연휴",
    "2027-09-15": "추석",
    "2027-09-16": "추석연휴",

    "2027-10-03": "개천절",
    "2027-10-09": "한글날",
    "2027-12-25": "성탄절"

  };


  /*
   * 공공데이터포털에 아직 공식 일정이 없는 먼 미래 연도용 예비 음력 날짜입니다.
   * 공식 API 자료가 있으면 그 자료를 먼저 사용합니다.
   */
  const PLANNED_LUNAR_DATES = {
    2028: { newYear: '2028-01-27', buddha: '2028-05-02', chuseok: '2028-10-03' },
    2029: { newYear: '2029-02-13', buddha: '2029-05-20', chuseok: '2029-09-22' },
    2030: { newYear: '2030-02-03', buddha: '2030-05-09', chuseok: '2030-09-12' },
    2031: { newYear: '2031-01-23', buddha: '2031-05-28', chuseok: '2031-10-01' },
    2032: { newYear: '2032-02-11', buddha: '2032-05-16', chuseok: '2032-09-19' },
    2033: { newYear: '2033-01-31', buddha: '2033-05-06', chuseok: '2033-09-08' },
    2034: { newYear: '2034-02-19', buddha: '2034-05-25', chuseok: '2034-09-27' },
    2035: { newYear: '2035-02-08', buddha: '2035-05-15', chuseok: '2035-09-16' },
    2036: { newYear: '2036-01-28', buddha: '2036-05-03', chuseok: '2036-10-04' },
    2037: { newYear: '2037-02-15', buddha: '2037-05-22', chuseok: '2037-09-24' },
    2038: { newYear: '2038-02-04', buddha: '2038-05-11', chuseok: '2038-09-13' },
    2039: { newYear: '2039-01-24', buddha: '2039-04-30', chuseok: '2039-10-02' },
    2040: { newYear: '2040-02-12', buddha: '2040-05-18', chuseok: '2040-09-21' },
    2041: { newYear: '2041-02-01', buddha: '2041-05-07', chuseok: '2041-09-10' },
    2042: { newYear: '2042-01-22', buddha: '2042-05-26', chuseok: '2042-09-28' },
    2043: { newYear: '2043-02-10', buddha: '2043-05-16', chuseok: '2043-09-17' },
    2044: { newYear: '2044-01-30', buddha: '2044-05-05', chuseok: '2044-10-05' },
    2045: { newYear: '2045-02-17', buddha: '2045-05-24', chuseok: '2045-09-25' },
    2046: { newYear: '2046-02-06', buddha: '2046-05-13', chuseok: '2046-09-15' },
    2047: { newYear: '2047-01-26', buddha: '2047-05-02', chuseok: '2047-10-04' },
    2048: { newYear: '2048-02-14', buddha: '2048-05-20', chuseok: '2048-09-22' },
    2049: { newYear: '2049-02-02', buddha: '2049-05-09', chuseok: '2049-09-11' },
    2050: { newYear: '2050-01-23', buddha: '2050-05-28', chuseok: '2050-09-30' }
  };


  /*
   * ==========================================
   * 전역 변수
   * ==========================================
   */


  const PATTERN = [
    '주간',
    '주간',
    '휴무',
    '휴무',
    '야간',
    '야간',
    '휴무',
    '휴무'
  ];


  const TEAM_OFFSET = {

    'A': 0,
    'C': 2,
    'D': 4,
    'B': 6

  };


  const BASE_DATE =
    new Date('2026-09-30T00:00:00');


  const TEAMS = [
    'A',
    'B',
    'C',
    'D'
  ];


  /*
   * ==========================================
   * 권한 함수
   * ==========================================
   */

  // 슈퍼관리자

  function plusDays(dateStr, days) {

    const date = new Date(`${dateStr}T00:00:00Z`);

    date.setUTCDate(
      date.getUTCDate() + days
    );

    return date
      .toISOString()
      .slice(0, 10);

  }


  function getUtcDay(dateStr) {

    return new Date(
      `${dateStr}T00:00:00Z`
    ).getUTCDay();

  }


  function addPlannedHolidays(year) {

    const holidays = [];

    const addHoliday = (date, name, canSubstitute) => {

      holidays.push({
        date,
        name,
        canSubstitute
      });

    };


    [
      ['01-01', '신정', false],
      ['03-01', '3·1절', true],
      ['05-05', '어린이날', true],
      ['06-06', '현충일', false],
      ['08-15', '광복절', true],
      ['10-03', '개천절', true],
      ['10-09', '한글날', true],
      ['12-25', '성탄절', true]
    ].forEach(([monthDay, name, canSubstitute]) => {

      addHoliday(
        `${year}-${monthDay}`,
        name,
        canSubstitute
      );

    });


    const lunar =
      PLANNED_LUNAR_DATES[year];


    if (lunar) {

      [-1, 0, 1].forEach(offset => {

        const date = plusDays(
          lunar.newYear,
          offset
        );

        addHoliday(
          date,
          offset === 0 ? '설날' : '설연휴',
          true
        );

      });


      addHoliday(
        lunar.buddha,
        '부처님오신날',
        true
      );


      [-1, 0, 1].forEach(offset => {

        const date = plusDays(
          lunar.chuseok,
          offset
        );

        addHoliday(
          date,
          offset === 0 ? '추석' : '추석연휴',
          true
        );

      });

    }


    const dates = new Set(
      holidays.map(holiday => holiday.date)
    );

    const duplicateDates =
      holidays.reduce((counts, holiday) => {

        counts[holiday.date] =
          (counts[holiday.date] || 0) + 1;

        return counts;

      }, {});


    holidays.forEach(holiday => {

      HOLIDAYS[holiday.date] =
        HOLIDAYS[holiday.date] ||
        holiday.name;

    });


    holidays
      .filter(holiday => holiday.canSubstitute)
      .forEach(holiday => {

        if (
          getUtcDay(holiday.date) !== 0 &&
          duplicateDates[holiday.date] < 2
        ) {

          return;

        }


        let substituteDate =
          plusDays(holiday.date, 1);


        while (
          dates.has(substituteDate) ||
          getUtcDay(substituteDate) === 0
        ) {

          substituteDate = plusDays(
            substituteDate,
            1
          );

        }


        dates.add(substituteDate);

        HOLIDAYS[substituteDate] =
          '대체공휴일';

      });

  }


  function getShiftInfo(
    team,
    dateObj
  ) {

    const targetDate =
      new Date(
        dateObj.getFullYear(),
        dateObj.getMonth(),
        dateObj.getDate()
      );

    const baseDate =
      new Date(
        BASE_DATE.getFullYear(),
        BASE_DATE.getMonth(),
        BASE_DATE.getDate()
      );

    const diffTime =
      targetDate - baseDate;

    const diffDays =
      Math.floor(
        diffTime /
        (1000 * 60 * 60 * 24)
      );

    let index =
      (
        diffDays +
        TEAM_OFFSET[team]
      ) % 8;

    if (index < 0) {
      index += 8;
    }

    return PATTERN[index];

  }


  /*
   * ==========================================
   * 추천 대근 조
   * ==========================================
   */

  function getSuggestedHelperTeam(
    targetTeam,
    shiftType,
    dateObj
  ) {

    const prevDate =
      new Date(dateObj);

    prevDate.setDate(
      dateObj.getDate() - 1
    );


    const nextDate =
      new Date(dateObj);

    nextDate.setDate(
      dateObj.getDate() + 1
    );


    let helperTeam = '';


    TEAMS.forEach(t => {

      if (t === targetTeam) {
        return;
      }


      const pShift =
        getShiftInfo(
          t,
          prevDate
        );


      const nShift =
        getShiftInfo(
          t,
          nextDate
        );


      if (
        shiftType === '주간'
      ) {

        if (
          pShift === '주간' ||
          nShift === '주간'
        ) {

          helperTeam =
            t + '조';

        }

      } else if (
        shiftType === '야간'
      ) {

        if (
          pShift === '야간' ||
          nShift === '야간'
        ) {

          helperTeam =
            t + '조';

        }

      }

    });


    return helperTeam;

  }


  function getShortShift(shift) {

    if (shift === '주간') {
      return '주';
    }

    if (shift === '야간') {
      return '야';
    }

    return '휴';

  }


  function getShiftClass(shift) {

    if (shift === '주간') {
      return 's-day';
    }

    if (shift === '야간') {
      return 's-night';
    }

    return 's-off';

  }



function localDateKey(date) {
  return [date.getFullYear(), String(date.getMonth()+1).padStart(2,'0'), String(date.getDate()).padStart(2,'0')].join('-');
}
function weekStart(date) {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  start.setDate(start.getDate() - start.getDay());
  return start;
}
function visibleTeamRowIndexes(weekDate, team, data, today, compact = true) {
  const start = weekStart(weekDate);
  const end = new Date(start); end.setDate(end.getDate()+7);
  const daily = Array.from({length:7}, (_,day) => {
    const date = new Date(start); date.setDate(date.getDate()+day);
    return data.filter(request => request.team === team && request.shift_date === localDateKey(date));
  });
  const count = Math.max(1, ...daily.map(rows => rows.length+1));
  const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const indexes = Array.from({length:count}, (_,index)=>index);
  if (!compact || end > midnight) return indexes;
  // Only stored request/support/helper data count; automatic guide labels never enter this calculation.
  const filled = indexes.filter(index => daily.some(rows => {
    const request = rows[index];
    return request && (String(request.requested_by ?? '').trim() ||
      String(request.filled_by ?? '').trim() || request.request_kind === 'support' ||
      String(request.reason ?? '').trim() || request.requested_by_id != null);
  }));
  return filled.length ? filled : [0];
}

  function renderCalendar() {

    document
      .getElementById('currentMonthStr')
      .innerText =
      `${currentYear}년 ${currentMonth + 1}월`;


    const grid =
      document.getElementById(
        'calendarGrid'
      );


    grid.innerHTML = '';


    const firstDay =
      new Date(
        currentYear,
        currentMonth,
        1
      ).getDay();


    const lastDate =
      new Date(
        currentYear,
        currentMonth + 1,
        0
      ).getDate();


    /*
     * ==========================================
     * 주별 / 조별 휴무 행 수 계산
     * ==========================================
     *
     * 핵심:
     * A조에서 휴무 신청이 1건 발생하면
     * 그 주의 모든 날짜에 A조 행을 1줄 확보합니다.
     *
     * B조에서 2건이면
     * 그 주의 모든 날짜에 B조 행을 2줄 확보합니다.
     *
     * 따라서 조의 행이 다른 조를 밀어내지 않고,
     * A → B → C → D 순서가 모든 날짜에서 유지됩니다.
     */

    const weekTeamRows = {};


    for (
      let checkDay = 1;
      checkDay <= lastDate;
      checkDay++
    ) {

      const checkDate =
        new Date(
          currentYear,
          currentMonth,
          checkDay
        );


      const checkDateStr =
        `${currentYear}-${String(currentMonth + 1).padStart(2, '0')}-${String(checkDay).padStart(2, '0')}`;


      const weekStartDay =
        checkDay -
        checkDate.getDay() +
        1;


      const weekKey =
        `${currentYear}-${currentMonth}-${weekStartDay}`;


      if (!weekTeamRows[weekKey]) {
        weekTeamRows[weekKey] = {};
      }


      TEAMS.forEach(team => {

        const requestCount =
          requestsData.filter(
            r =>
              r.shift_date === checkDateStr &&
              r.team === team
          ).length;


        /*
         * 기본 조 행은 항상 1개 유지하고,
         * 휴무 신청자 수만큼 그 바로 아래에 추가 행을 만듭니다.
         *
         * 예:
         * 신청 0명 → 기본 1행
         * 신청 1명 → 기본 1행 + 추가 1행 = 2행
         * 신청 2명 → 기본 1행 + 추가 2행 = 3행
         */
        /*
         * 해당 주의 이 조는:
         * - 휴무 신청자 N명
         * - + 다음 신청을 위한 빈 행 1개
         *
         * 총 N + 1행을 확보합니다.
         *
         * 신청 0명 → 기본 1행
         * 신청 1명 → 신청자 1행 + 빈 행 1개 = 2행
         * 신청 2명 → 신청자 2행 + 빈 행 1개 = 3행
         */
        weekTeamRows[weekKey][team] =
          Math.max(
            weekTeamRows[weekKey][team] || 1,
            requestCount + 1
          );

      });

    }


    // 지난 주만 일요일~토요일 전체의 실제 입력을 검사합니다.
    // 이번 주와 미래 주는 기존 월내 최대 신청 수 + 빈 행을 유지합니다.
    const calendarToday = new Date();
    for (let day = 1; day <= lastDate; day++) {
      const date = new Date(currentYear, currentMonth, day);
      const key = `${currentYear}-${currentMonth}-${day-date.getDay()+1}`;
      if (Array.isArray(weekTeamRows[key][TEAMS[0]])) continue;
      const nextSunday = weekStart(date);
      nextSunday.setDate(nextSunday.getDate()+7);
      const todayStart = new Date(calendarToday.getFullYear(), calendarToday.getMonth(), calendarToday.getDate());
      for (const team of TEAMS) {
        weekTeamRows[key][team] = nextSunday <= todayStart
          ? visibleTeamRowIndexes(date, team, requestsData, calendarToday)
          : Array.from({length:weekTeamRows[key][team]}, (_,index)=>index);
      }
    }

    for (
      let i = 0;
      i < firstDay;
      i++
    ) {

      grid.innerHTML +=
        `<div></div>`;

    }


    for (
      let d = 1;
      d <= lastDate;
      d++
    ) {

      const dateObj =
        new Date(
          currentYear,
          currentMonth,
          d
        );


      const yyyy =
        currentYear;


      const mm =
        String(
          currentMonth + 1
        ).padStart(
          2,
          '0'
        );


      const dd =
        String(d).padStart(
          2,
          '0'
        );


      const dateStr =
        `${yyyy}-${mm}-${dd}`;


      const dayOfWeek =
        dateObj.getDay();


      const holidayName =
        HOLIDAYS[dateStr];


      let dateColorStyle = '';


      if (
        dayOfWeek === 0 ||
        holidayName
      ) {

        dateColorStyle =
          'color: #e74c3c;';

      } else if (
        dayOfWeek === 6
      ) {

        dateColorStyle =
          'color: #007bff;';

      }


      let holidayHtml =
        holidayName
          ? `<span class="holiday-name">(${holidayName})</span>`
          : '';


      let dayHtml = `
        <div class="day-cell" id="calendar-day-${dateStr}">

          <div class="day-header-bar">

            <div
              class="day-date-part"
              style="${dateColorStyle}"
            >
              ${mm}/${dd} ${holidayHtml}
            </div>

            <div class="day-sub-title">
              대근
            </div>

          </div>
      `;


      const weekStartDay =
        d -
        dateObj.getDay() +
        1;


      const weekKey =
        `${currentYear}-${currentMonth}-${weekStartDay}`;


      /*
       * ======================================
       * A / B / C / D 조
       * ======================================
       *
       * 조별로 먼저 '필요한 행 수'를 확보합니다.
       * 그래서 B조 신청자가 2명이어도
       * C조가 B조의 두 번째 행 위치로 밀려나지 않습니다.
       */

      TEAMS.forEach(team => {

        const shift =
          getShiftInfo(
            team,
            dateObj
          );


        const isMyTeam =
          (
            currentUser &&
            team === currentUser.team
          )
            ? 'my-team-row'
            : '';


        const offRequestClass =
          (
            shift === '휴무'
          )
            ? 'off-request-cell'
            : '';


        const reqsForTeam =
          requestsData.filter(
            r =>
              r.shift_date === dateStr &&
              r.team === team
          );


        let suggestedTeam = '';


        if (
          shift !== '휴무'
        ) {

          suggestedTeam =
            getSuggestedHelperTeam(
              team,
              shift,
              dateObj
            );

        }


        const rowsForThisTeam =
          (
            weekTeamRows[weekKey] &&
            weekTeamRows[weekKey][team]
          ) || [0];


        /*
         * 이 주의 이 조에서 필요한 만큼만 행을 만듭니다.
         * 실제 신청자가 있는 날짜에는 신청자를 순서대로 넣고,
         * 나머지 날짜에는 빈 행을 유지합니다.
         */

        for (const rowIndex of rowsForThisTeam) {

          /*
           * 기존 조 행 자체가 첫 번째 휴무 신청 행입니다.
           * 따라서 신청자가 있으면 rowIndex 0부터 순서대로 표시하고,
           * 마지막 1행은 다음 신청을 위한 빈 행으로 남깁니다.
           */
          const req =
            reqsForTeam[rowIndex] ||
            null;


          let reqName = '';
          let reqClick = '';
          let reqClass =
            `cell-name req-cell-${team} ${offRequestClass}`;


          let subName = '';
          let subClick = '';
          let subCellClass =
            `cell-name sub-cell-${team}`;


          /*
           * 실제 휴무 신청이 있는 행
           */
          if (req) {

            const reasonHtml =
              !isSupportRequest(req) && req.reason
                ? `<span class="reason-text">(${escapeRequestText(req.reason)})</span>`
                : '';


            reqName = `
              <div class="has-data req-data person-team-${team}">
                <span>${escapeRequestText(requestDisplayName(req))}</span>
                ${reasonHtml}
              </div>
            `;


            if (
              currentUser &&
              (
                isOwnRequest(req) ||
                isSuperAdmin()
              )
            ) {

              reqClick =
                `onclick="deleteRequest('${req.id}', '${isSupportRequest(req) ? '추가 지원' : '휴무 신청'}')"`;

              reqClass +=
                ' clickable';

            }


            if (req.filled_by) {

              subName = `
                <div class="has-data sub-data ${TEAMS.includes(req.helper_team) ? `person-team-${req.helper_team}` : ''}">
                  <span>${escapeRequestText(req.filled_by)}</span>
                </div>
              `;


              if (
                currentUser &&
                (
                  req.filled_by === currentUser.name ||
                  isSuperAdmin() ||
                  (
                    isTeamAdmin() &&
                    canRegisterSubstitution(req.team)
                  )
                )
              ) {

                subClick =
                  `onclick="cancelSub('${req.id}')"`;

                subCellClass +=
                  ' clickable';

              }

            } else {

              if (suggestedTeam) {

                subName =
                  `<span class="suggest-guide">${suggestedTeam}</span>`;

                subCellClass +=
                  ' suggest-box';

              }


              if (
                canRegisterSubstitution(team)
              ) {

                subClick =
                  `onclick="acceptRequest('${req.id}', '${team}', '${dateStr}', '${shift}')"`;

                subCellClass +=
                  ' clickable';

              }

            }

          }


          /*
           * 실제 신청이 없는 빈 행
           */
          else {

            /*
             * 아직 내 신청이 없다면
             * 이 빈 행에서 휴무 신청을 추가할 수 있습니다.
             */
            if (
              canRequestOff() &&
              shift !== '휴무' &&
              (
                isSuperAdmin() ||
                team === currentUser.team
              )
            ) {

              reqClick =
                `onclick="requestOff('${dateStr}', '${shift}', '${team}')"`;

              reqClass +=
                ' clickable';

            }


            let suggestGuideHtml = '';


            if (
              shift !== '휴무' &&
              suggestedTeam
            ) {

              suggestGuideHtml =
                `<span class="suggest-guide">${suggestedTeam}</span>`;

              subCellClass +=
                ' suggest-box';

            }


            /*
             * 빈 행의 대근 칸:
             * 해당 날짜/조에 실제 휴무 신청이 없으므로
             * 대근 등록은 불가합니다.
             */
            subClick =
              `onclick="alert('🚫 이 대근 칸에는 등록 가능한 휴무 신청이 없습니다. 먼저 해당 조의 휴무 신청을 등록해 주세요.');"`;

            subName =
              suggestGuideHtml;

          }


          dayHtml += `

            <div class="team-row ${isMyTeam}">

              <div class="cell-shift ${getShiftClass(shift)}">
                ${team}${getShortShift(shift)}
              </div>

              <div
                class="${reqClass}"
                ${reqClick}
                title="${reqClick ? '클릭 시 휴무·추가 지원 신청/삭제' : ''}"
              >
                ${reqName}
              </div>

              <div
                class="${subCellClass}"
                ${subClick}
                title="클릭 시 대근 등록/취소"
              >
                ${subName}
              </div>

            </div>

          `;

        }

      });


      /*
       * ==================================
       * 메모
       * ==================================
       */

      const memoSlots=memoSlotsForWeek(dateObj,memosData);
      for(const slot of memoSlots){
        const entry=memosData.find(m=>m.date===dateStr && memoSlotKey(m)===slot.key);
        const label=slot.team?slot.team+'조 메모':slot.key==='empty'?'메모':'기존 메모';
        const entryId=entry?String(entry.id):'';
        dayHtml+=`<div class="team-row memo-row" data-memo-week="${localDateKey(weekStart(dateObj))}" data-memo-slot="${escapeRequestText(slot.key)}"><div class="cell-shift" style="color:#795548;font-size:10px">${escapeRequestText(label)}</div><div class="cell-name clickable" style="justify-content:center;text-align:center;padding:0 4px;font-size:11px;font-weight:bold;color:#333" onclick="editMemo('${dateStr}','${entryId}','${slot.team||''}')" title="같은 조만 수정·삭제할 수 있습니다. 다른 조는 메모를 추가할 수 있습니다.">${escapeRequestText(entry?.memo||'')}</div></div>`;
      }
      dayHtml+='</div>';

      grid.innerHTML +=
        dayHtml;

    }
    if(typeof requestAnimationFrame==='function')requestAnimationFrame(()=>synchronizeMemoRowHeights(grid));

  }

  /*
   * ==========================================
   * 휴무 신청
   * ==========================================
   */


  function escapeRequestText(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[character]));
  }

  function isSupportReason(reason) {
    return /정수|지원/.test(String(reason ?? ''));
  }

  function isSupportRequest(request) {
    return request.request_kind === 'support' || isSupportReason(request.reason);
  }

  function requestDisplayName(request) {
    const reason = String(request.reason ?? '');
    if (reason.includes('정수')) return '정수 지원';
    if (reason.includes('지원')) return '지원';
    return request.request_kind === 'support'
      ? reason.trim() || '지원'
      : request.requested_by;
  }



// Keep multi-line memo heights aligned across the whole week, including after resize.
function synchronizeMemoRowHeights(grid){
 if(!grid?.querySelectorAll)return;
 const rows=[...grid.querySelectorAll('[data-memo-week][data-memo-slot]')],heights=new Map();
 rows.forEach(row=>row.style.minHeight='');
 rows.forEach(row=>{const key=row.dataset.memoWeek+':'+row.dataset.memoSlot;heights.set(key,Math.max(heights.get(key)||35,Math.ceil(row.getBoundingClientRect().height)));});
 rows.forEach(row=>{row.style.minHeight=heights.get(row.dataset.memoWeek+':'+row.dataset.memoSlot)+'px';});
}
if(typeof window!=='undefined')window.addEventListener('resize',()=>{if(typeof requestAnimationFrame==='function')requestAnimationFrame(()=>synchronizeMemoRowHeights(document.getElementById('calendarGrid')));});
