import { Plus, X } from 'lucide-react';
import { NativeSelect } from '@/components/native-select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export interface ScheduleValue {
  type: 'IMMEDIATE' | 'DAILY' | 'WEEKLY' | 'INTERVAL';
  times?: string[];
  days?: number[];
  time?: string;
  hours?: number;
}

const DAYS = [
  [1, '월'],
  [2, '화'],
  [3, '수'],
  [4, '목'],
  [5, '금'],
  [6, '토'],
  [7, '일'],
] as const;
const INTERVALS = [1, 2, 3, 4, 6, 8, 12];
const MAX_TIMES = 6;

/** 방식을 바꿀 때 채워 넣을 기본값 */
function defaults(type: ScheduleValue['type']): ScheduleValue {
  switch (type) {
    case 'DAILY':
      return { type, times: ['09:00'] };
    case 'WEEKLY':
      return { type, days: [1], time: '09:00' };
    case 'INTERVAL':
      return { type, hours: 6 };
    default:
      return { type: 'IMMEDIATE' };
  }
}

/** 규칙별 받는 시간 선택. 시각은 사용자 시간대(시간대·방해 금지 탭) 기준이다. */
export function SchedulePicker({ value, onChange, idPrefix = 'sch' }: { value: ScheduleValue; onChange: (value: ScheduleValue) => void; idPrefix?: string }) {
  const times = value.times ?? [];
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-type`}>받는 시간</Label>
        <NativeSelect id={`${idPrefix}-type`} value={value.type} onChange={(e) => onChange(defaults(e.target.value as ScheduleValue['type']))}>
          <option value="IMMEDIATE">즉시 - 생길 때마다 바로</option>
          <option value="DAILY">매일 - 정한 시각에 모아서</option>
          <option value="WEEKLY">매주 - 정한 요일·시각에 모아서</option>
          <option value="INTERVAL">N시간마다 - 모아서</option>
        </NativeSelect>
      </div>

      {value.type === 'DAILY' ? (
        <fieldset className="space-y-1.5">
          <legend className="text-sm font-medium">시각 (하루 {MAX_TIMES}번까지)</legend>
          <div className="flex flex-wrap items-center gap-2">
            {times.map((time, index) => (
              <div key={index} className="flex items-center gap-1">
                <Input
                  type="time"
                  aria-label={`${index + 1}번째 시각`}
                  className="w-32"
                  value={time}
                  onChange={(e) => onChange({ ...value, times: times.map((t, i) => (i === index ? e.target.value : t)) })}
                />
                {times.length > 1 ? (
                  <Button type="button" size="icon" variant="ghost" aria-label={`${time} 삭제`} onClick={() => onChange({ ...value, times: times.filter((_, i) => i !== index) })}>
                    <X aria-hidden />
                  </Button>
                ) : null}
              </div>
            ))}
            {times.length < MAX_TIMES ? (
              <Button type="button" size="sm" variant="outline" onClick={() => onChange({ ...value, times: [...times, '18:00'] })}>
                <Plus aria-hidden /> 시각 추가
              </Button>
            ) : null}
          </div>
        </fieldset>
      ) : null}

      {value.type === 'WEEKLY' ? (
        <div className="space-y-2">
          <fieldset className="space-y-1.5">
            <legend className="text-sm font-medium">요일</legend>
            <div className="flex flex-wrap gap-1.5">
              {DAYS.map(([day, label]) => {
                const days = value.days ?? [];
                const active = days.includes(day);
                return (
                  <Button
                    key={day}
                    type="button"
                    size="sm"
                    variant={active ? 'default' : 'outline'}
                    aria-pressed={active}
                    onClick={() => onChange({ ...value, days: active ? days.filter((d) => d !== day) : [...days, day].sort() })}
                  >
                    {label}
                  </Button>
                );
              })}
            </div>
          </fieldset>
          <div className="space-y-1.5">
            <Label htmlFor={`${idPrefix}-weekly-time`}>시각</Label>
            <Input id={`${idPrefix}-weekly-time`} type="time" className="w-32" value={value.time ?? '09:00'} onChange={(e) => onChange({ ...value, time: e.target.value })} />
          </div>
        </div>
      ) : null}

      {value.type === 'INTERVAL' ? (
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-hours`}>간격</Label>
          <NativeSelect id={`${idPrefix}-hours`} className="w-40" value={value.hours ?? 6} onChange={(e) => onChange({ ...value, hours: Number(e.target.value) })}>
            {INTERVALS.map((hours) => (
              <option key={hours} value={hours}>
                {hours}시간마다
              </option>
            ))}
          </NativeSelect>
          <p className="text-xs text-muted-foreground">자정부터 시작해 정각에 보냅니다 (예: 6시간마다 → 0시·6시·12시·18시).</p>
        </div>
      ) : null}

      {value.type !== 'IMMEDIATE' ? (
        <p className="text-xs text-muted-foreground">그 사이에 생긴 알림을 정한 시각에 한 번에 모아 보냅니다. 보낼 것이 없으면 보내지 않습니다.</p>
      ) : null}
    </div>
  );
}
