import { Plus, X } from 'lucide-react';
import { NativeSelect } from '@/components/native-select';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export interface ScheduleValue {
  type: 'IMMEDIATE' | 'DAILY' | 'WEEKLY' | 'INTERVAL';
  times?: string[];
  /** DAILY: 토·일에 쓸 시각. 없으면 매일 같은 시각, 빈 배열이면 주말에는 보내지 않음 */
  weekendTimes?: string[];
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

/** 시각 목록 편집 (추가·삭제) */
function TimeList({ label, times, onChange, allowEmpty = false, emptyText }: { label: string; times: string[]; onChange: (times: string[]) => void; allowEmpty?: boolean; emptyText?: string }) {
  return (
    <fieldset className="space-y-1.5">
      <legend className="text-sm font-medium">{label}</legend>
      <div className="flex flex-wrap items-center gap-2">
        {times.length === 0 && emptyText ? <span className="text-sm text-muted-foreground">{emptyText}</span> : null}
        {times.map((time, index) => (
          <div key={index} className="flex items-center gap-1">
            <Input
              type="time"
              aria-label={`${label} ${index + 1}번째`}
              className="w-32"
              value={time}
              onChange={(e) => onChange(times.map((t, i) => (i === index ? e.target.value : t)))}
            />
            {times.length > 1 || allowEmpty ? (
              <Button type="button" size="icon" variant="ghost" aria-label={`${time} 삭제`} onClick={() => onChange(times.filter((_, i) => i !== index))}>
                <X aria-hidden />
              </Button>
            ) : null}
          </div>
        ))}
        {times.length < MAX_TIMES ? (
          <Button type="button" size="sm" variant="outline" onClick={() => onChange([...times, times.length === 0 ? '12:00' : '18:00'])}>
            <Plus aria-hidden /> 시각 추가
          </Button>
        ) : null}
      </div>
    </fieldset>
  );
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
        <div className="space-y-2">
          <TimeList label={value.weekendTimes ? `평일 시각 (하루 ${MAX_TIMES}번까지)` : `시각 (하루 ${MAX_TIMES}번까지)`} times={times} onChange={(next) => onChange({ ...value, times: next })} />
          <div className="flex items-center gap-2">
            <Checkbox
              id={`${idPrefix}-weekend`}
              checked={value.weekendTimes !== undefined}
              onCheckedChange={(checked) => onChange(checked === true ? { ...value, weekendTimes: ['12:00'] } : { type: 'DAILY', times })}
            />
            <Label htmlFor={`${idPrefix}-weekend`} className="font-normal">
              주말(토·일)은 다른 시각에 받기
            </Label>
          </div>
          {value.weekendTimes ? (
            <TimeList label="주말 시각" times={value.weekendTimes} allowEmpty emptyText="주말에는 보내지 않음" onChange={(next) => onChange({ ...value, weekendTimes: next })} />
          ) : null}
        </div>
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
        <p className="text-xs text-muted-foreground">그 사이에 생긴 알림을 정한 시각에 한 번에 모아 보냅니다.</p>
      ) : null}
    </div>
  );
}
