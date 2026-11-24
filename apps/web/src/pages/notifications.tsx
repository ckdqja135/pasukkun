import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, CircleDashed, Pause, Pencil, Play, Plus, Send, Trash2 } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { PageHeader } from '@/components/app-shell';
import { Pill } from '@/components/badges';
import { SchedulePicker, type ScheduleValue } from '@/components/schedule-picker';
import { TemplateEditor } from '@/components/template-editor';
import { NativeSelect } from '@/components/native-select';
import { EmptyState, ErrorState, LoadingState, UnsupportedNote } from '@/components/states';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, unwrap, type Schemas } from '@/lib/api';
import { ME_KEY, useMe } from '@/lib/auth';
import { EVENT_LABEL, formatRelative, minutesToTime, SEVERITY_LABEL, timeToMinutes } from '@/lib/labels';
import { useInterests, useProjects } from '@/lib/queries';

type Channel = Schemas['ChannelDto'];
type Rule = Schemas['RuleDto'];
type RuleInput = Schemas['RuleInputDto'];
type EventType = RuleInput['eventTypes'][number];

const TECH_EVENTS: EventType[] = ['TECH_NEW_VULN', 'KEV_ADDED', 'PATCH_AVAILABLE', 'AFFECTED_RANGE_CHANGED'];
const PROJECT_EVENTS: EventType[] = ['PROJECT_NEW_MATCH', 'PRIORITY_RAISED', 'KEV_ADDED', 'PATCH_AVAILABLE', 'AFFECTED_RANGE_CHANGED', 'INITIAL_SCAN_SUMMARY'];

function ChannelStatus({ channel }: { channel: Channel }) {
  if (channel.status === 'ACTIVE') return <Pill tone="green" icon={CheckCircle2}>연결됨</Pill>;
  if (channel.status === 'PAUSED') return <Pill tone="gray" icon={Pause}>일시 중지</Pill>;
  return <Pill tone="red" icon={AlertTriangle}>연결 끊김</Pill>;
}

export function NotificationsPage() {
  return (
    <>
      <PageHeader
        title="알림 설정"
        description="알림을 받을 채널을 등록하고, 어떤 변화가 있을 때 받을지 규칙으로 정합니다. 관심 기술 알림과 프로젝트 영향 알림은 서로 다른 규칙입니다."
      />
      <Tabs defaultValue={new URLSearchParams(window.location.search).get('tab') ?? 'channels'}>
        <TabsList>
          <TabsTrigger value="channels">채널</TabsTrigger>
          <TabsTrigger value="rules">구독 규칙</TabsTrigger>
          <TabsTrigger value="schedule">시간대 · 방해 금지</TabsTrigger>
        </TabsList>
        <TabsContent value="channels">
          <ChannelsTab />
        </TabsContent>
        <TabsContent value="rules">
          <RulesTab />
        </TabsContent>
        <TabsContent value="schedule">
          <ScheduleTab />
        </TabsContent>
      </Tabs>
    </>
  );
}


function useChannels() {
  return useQuery({ queryKey: ['channels'], queryFn: () => unwrap(api.GET('/api/v1/channels')) });
}

function useProviders() {
  return useQuery({ queryKey: ['channel-providers'], queryFn: () => unwrap(api.GET('/api/v1/channels/providers')), staleTime: 5 * 60_000 });
}

const DISCORD_ERRORS: Record<string, string> = {
  expired: '디스코드 연결 요청이 만료되었습니다. 다시 시도해 주세요.',
  session: '연결을 시작한 계정으로 로그인한 같은 브라우저에서 마쳐야 합니다. 다시 시도해 주세요.',
  denied: '디스코드에서 연결을 취소했습니다.',
  discord: '디스코드에서 봇을 넣은 서버를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.',
};

function ChannelsTab() {
  const queryClient = useQueryClient();
  const channels = useChannels();
  const providers = useProviders();
  const [params, setParams] = useSearchParams();
  const [connecting, setConnecting] = useState<'TELEGRAM' | 'DISCORD' | null>(null);
  const [renaming, setRenaming] = useState<Channel | null>(null);
  const discordLink = params.get('discord_link');
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['channels'] });
    void queryClient.invalidateQueries({ queryKey: ['rules'] });
  };

  // 디스코드에서 돌아왔을 때의 결과를 보여주고 주소창을 정리한다.
  useEffect(() => {
    const error = params.get('discord_error');
    if (!error) return;
    toast.error(DISCORD_ERRORS[error] ?? '디스코드 연결에 실패했습니다.');
    const next = new URLSearchParams(params);
    next.delete('discord_error');
    setParams(next, { replace: true });
  }, [params, setParams]);

  const test = useMutation({
    mutationFn: (id: string) => unwrap(api.POST('/api/v1/channels/{id}/test', { params: { path: { id } } })),
    onSuccess: (result) => {
      invalidate();
      if (result.ok) toast.success(result.message);
      else toast.error(result.message);
    },
    onError: (error) => toast.error(error.message),
  });
  const pause = useMutation({
    mutationFn: ({ id, paused }: { id: string; paused: boolean }) =>
      unwrap(paused ? api.POST('/api/v1/channels/{id}/pause', { params: { path: { id } } }) : api.POST('/api/v1/channels/{id}/resume', { params: { path: { id } } })),
    onSuccess: invalidate,
    onError: (error) => toast.error(error.message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => unwrap(api.DELETE('/api/v1/channels/{id}', { params: { path: { id } } })),
    onSuccess: () => {
      invalidate();
      toast.success('채널을 삭제했습니다.');
    },
    onError: (error) => toast.error(error.message),
  });

  if (channels.isError) return <ErrorState error={channels.error} onRetry={() => channels.refetch()} />;
  if (!channels.data || !providers.data) return <LoadingState />;
  const available = providers.data;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>채널 연결</CardTitle>
          <CardDescription>서비스 봇이 알림을 보냅니다. 토큰이나 주소를 붙여 넣을 필요 없이 버튼을 눌러 연결하면 됩니다.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button onClick={() => setConnecting('TELEGRAM')} disabled={!available.telegram}>
            <Send aria-hidden /> 텔레그램 연결
          </Button>
          <Button onClick={() => setConnecting('DISCORD')} disabled={!available.discord} variant="outline">
            <Plus aria-hidden /> 디스코드 연결
          </Button>
          {!available.telegram || !available.discord ? (
            <p className="w-full text-xs text-muted-foreground">
              {[!available.telegram ? '텔레그램' : null, !available.discord ? '디스코드' : null].filter(Boolean).join(', ')} 봇이 이 서버에 아직 설정되지 않았습니다. 서버 운영자가 설정하면 사용할 수 있습니다.
            </p>
          ) : null}
        </CardContent>
      </Card>

      {channels.data.length === 0 ? (
        <EmptyState title="연결된 채널이 없습니다" description="텔레그램이나 디스코드를 연결하면 구독 규칙에 맞는 알림을 받을 수 있습니다." />
      ) : (
        <ul className="grid gap-3 lg:grid-cols-2">
          {channels.data.map((channel) => (
            <li key={channel.id}>
              <Card>
                <CardHeader>
                  <CardTitle className="flex flex-wrap items-center gap-2">
                    {channel.name}
                    <ChannelStatus channel={channel} />
                  </CardTitle>
                  <CardDescription>{channel.label}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  {channel.status === 'ERROR' && channel.lastError ? (
                    <Alert variant="destructive">
                      <AlertTitle>연결이 끊겼습니다 ({formatRelative(channel.lastErrorAt)})</AlertTitle>
                      <AlertDescription>{channel.lastError}</AlertDescription>
                    </Alert>
                  ) : null}
                  <p className="text-xs text-muted-foreground">마지막 발송 성공 {formatRelative(channel.lastSuccessAt)}</p>
                  <div className="flex flex-wrap gap-2">
                    {channel.status === 'ERROR' ? (
                      <Button size="sm" onClick={() => setConnecting(channel.type)}>
                        다시 연결
                      </Button>
                    ) : null}
                    <Button size="sm" variant="outline" disabled={test.isPending} onClick={() => test.mutate(channel.id)}>
                      <Send aria-hidden /> 테스트 발송
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => pause.mutate({ id: channel.id, paused: channel.status !== 'PAUSED' })}>
                      {channel.status === 'PAUSED' ? <Play aria-hidden /> : <Pause aria-hidden />}
                      {channel.status === 'PAUSED' ? '재개' : '일시 중지'}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setRenaming(channel)}>
                      <Pencil aria-hidden /> 이름 바꾸기
                    </Button>
                    <Button size="sm" variant="ghost" className="text-destructive" onClick={() => remove.mutate(channel.id)} aria-label={`${channel.name} 채널 삭제`}>
                      <Trash2 aria-hidden /> 삭제
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
      <UnsupportedNote title="지원 채널">
        현재 텔레그램과 디스코드를 지원합니다. Slack, 이메일, 사용자 정의 Webhook 은 아직 지원하지 않습니다.
      </UnsupportedNote>

      {connecting === 'TELEGRAM' ? <TelegramConnectDialog botUsername={available.telegramBotUsername} onClose={() => setConnecting(null)} onConnected={invalidate} /> : null}
      {connecting === 'DISCORD' ? <DiscordConnectDialog onClose={() => setConnecting(null)} /> : null}
      {discordLink ? (
        <DiscordChannelDialog
          requestId={discordLink}
          onClose={() => {
            const next = new URLSearchParams(params);
            next.delete('discord_link');
            setParams(next, { replace: true });
          }}
          onConnected={invalidate}
        />
      ) : null}
      {renaming ? <RenameDialog channel={renaming} onClose={() => setRenaming(null)} onSaved={invalidate} /> : null}
    </div>
  );
}

function NameStep({ defaultName, submitLabel, pending, onSubmit }: { defaultName: string; submitLabel: string; pending: boolean; onSubmit: (name: string) => void }) {
  const [name, setName] = useState(defaultName);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit(name.trim());
  };
  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="ch-name">채널 이름</Label>
        <Input id="ch-name" required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
        <p className="text-xs text-muted-foreground">구독 규칙에서 고를 때 보이는 이름입니다.</p>
      </div>
      <div className="flex justify-end">
        <Button type="submit" disabled={pending || !name.trim()}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

/** 텔레그램: 서비스 봇과의 대화를 열어 [시작]을 누르면 연결된다. 연결될 때까지 상태를 확인한다. */
function TelegramConnectDialog({ botUsername, onClose, onConnected }: { botUsername: string | null; onClose: () => void; onConnected: () => void }) {
  const start = useMutation({
    mutationFn: (name: string) => unwrap(api.POST('/api/v1/channels/telegram/link', { body: { name } })),
    onError: (error) => toast.error(error.message),
  });
  const link = start.data;
  const status = useQuery({
    queryKey: ['channel-link', link?.requestId],
    queryFn: () => unwrap(api.GET('/api/v1/channels/links/{id}', { params: { path: { id: link!.requestId } } })),
    enabled: Boolean(link),
    refetchInterval: (query) => (query.state.data?.status === 'PENDING' || !query.state.data ? 2000 : false),
  });
  const state = status.data?.status;

  useEffect(() => {
    if (state === 'COMPLETED') {
      onConnected();
      toast.success('텔레그램이 연결되었습니다. 텔레그램에 확인 메시지를 보냈습니다.');
      onClose();
    }
  }, [state, onConnected, onClose]);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>텔레그램 연결</DialogTitle>
          <DialogDescription>서비스 봇{botUsername ? ` @${botUsername}` : ''} 과 대화를 시작하면 그 대화방으로 알림을 보냅니다.</DialogDescription>
        </DialogHeader>
        {!link ? (
          <NameStep defaultName="텔레그램" submitLabel="연결 링크 만들기" pending={start.isPending} onSubmit={(name) => start.mutate(name)} />
        ) : state === 'EXPIRED' ? (
          <Alert variant="destructive">
            <AlertTitle>연결 링크가 만료되었습니다</AlertTitle>
            <AlertDescription>창을 닫고 다시 시도해 주세요.</AlertDescription>
          </Alert>
        ) : (
          <div className="space-y-4 text-sm">
            <ol className="list-decimal space-y-1 pl-5">
              <li>아래 버튼을 누르면 텔레그램이 열립니다.</li>
              <li>
                텔레그램에서 <strong>시작</strong>(Start)을 누르세요.
              </li>
              <li>이 창은 연결되면 자동으로 닫힙니다.</li>
            </ol>
            <div className="flex flex-wrap gap-2">
              <Button asChild>
                <a href={link.url} target="_blank" rel="noopener noreferrer">
                  <Send aria-hidden /> 개인 대화로 받기
                </a>
              </Button>
              <Button asChild variant="outline">
                <a href={link.groupUrl} target="_blank" rel="noopener noreferrer">
                  그룹에 추가해서 받기
                </a>
              </Button>
            </div>
            <p role="status" aria-live="polite" className="flex items-center gap-2 text-xs text-muted-foreground">
              <CircleDashed className="size-3 animate-spin" aria-hidden /> 텔레그램에서 시작을 누르기를 기다리는 중… (링크는 15분 동안 유효합니다)
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** 디스코드: 디스코드 화면에서 봇을 넣을 서버를 고른다. 돌아오면 채널을 고른다. */
function DiscordConnectDialog({ onClose }: { onClose: () => void }) {
  const start = useMutation({
    mutationFn: (name: string) => unwrap(api.POST('/api/v1/channels/discord/link', { body: { name } })),
    onSuccess: (link) => {
      window.location.href = link.url;
    },
    onError: (error) => toast.error(error.message),
  });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>디스코드 연결</DialogTitle>
          <DialogDescription>
            디스코드로 이동해 서비스 봇을 넣을 서버를 고릅니다. 서버 관리 권한이 있는 서버만 고를 수 있습니다. 돌아오면 알림을 받을 채널을 고릅니다.
          </DialogDescription>
        </DialogHeader>
        <NameStep defaultName="디스코드" submitLabel="디스코드로 이동" pending={start.isPending} onSubmit={(name) => start.mutate(name)} />
      </DialogContent>
    </Dialog>
  );
}

function DiscordChannelDialog({ requestId, onClose, onConnected }: { requestId: string; onClose: () => void; onConnected: () => void }) {
  const status = useQuery({ queryKey: ['channel-link', requestId], queryFn: () => unwrap(api.GET('/api/v1/channels/links/{id}', { params: { path: { id: requestId } } })), retry: false });
  const options = useQuery({
    queryKey: ['discord-channels', requestId],
    queryFn: () => unwrap(api.GET('/api/v1/channels/links/{id}/discord-channels', { params: { path: { id: requestId } } })),
    enabled: status.data?.status === 'GUILD_SELECTED',
    retry: false,
  });
  const [channelId, setChannelId] = useState('');
  const complete = useMutation({
    mutationFn: () => unwrap(api.POST('/api/v1/channels/links/{id}/discord-complete', { params: { path: { id: requestId } }, body: { channelId } })),
    onSuccess: () => {
      onConnected();
      toast.success('디스코드가 연결되었습니다. 그 채널에 확인 메시지를 보냈습니다.');
      onClose();
    },
    onError: (error) => toast.error(error.message),
  });
  useEffect(() => {
    if (!channelId && options.data?.[0]) setChannelId(options.data[0].id);
  }, [options.data, channelId]);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>알림 받을 채널 고르기</DialogTitle>
          <DialogDescription>{status.data?.guildName ? `"${status.data.guildName}" 서버에 봇이 들어갔습니다.` : '디스코드 서버를 확인하는 중입니다.'}</DialogDescription>
        </DialogHeader>
        {status.isError || (status.data && status.data.status !== 'GUILD_SELECTED') ? (
          <Alert variant="destructive">
            <AlertTitle>연결을 이어갈 수 없습니다</AlertTitle>
            <AlertDescription>요청이 만료되었거나 이미 처리되었습니다. 창을 닫고 다시 시도해 주세요.</AlertDescription>
          </Alert>
        ) : !options.data ? (
          options.isError ? <ErrorState error={options.error} onRetry={() => options.refetch()} /> : <LoadingState />
        ) : options.data.length === 0 ? (
          <EmptyState title="봇이 볼 수 있는 텍스트 채널이 없습니다" description="디스코드 서버 설정에서 봇 역할에 채널 보기·메시지 보내기 권한을 준 뒤 다시 시도해 주세요." />
        ) : (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              complete.mutate();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="dc-channel">채널</Label>
              <NativeSelect id="dc-channel" value={channelId} onChange={(e) => setChannelId(e.target.value)}>
                {options.data.map((option) => (
                  <option key={option.id} value={option.id}>
                    #{option.name}
                  </option>
                ))}
              </NativeSelect>
              <p className="text-xs text-muted-foreground">연결하면 이 채널에 확인 메시지를 한 번 보냅니다.</p>
            </div>
            <div className="flex justify-end">
              <Button type="submit" disabled={!channelId || complete.isPending}>
                이 채널로 연결
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function RenameDialog({ channel, onClose, onSaved }: { channel: Channel; onClose: () => void; onSaved: () => void }) {
  const save = useMutation({
    mutationFn: (name: string) => unwrap(api.PATCH('/api/v1/channels/{id}', { params: { path: { id: channel.id } }, body: { name } })),
    onSuccess: () => {
      onSaved();
      onClose();
    },
    onError: (error) => toast.error(error.message),
  });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>채널 이름 바꾸기</DialogTitle>
          <DialogDescription>{channel.label}</DialogDescription>
        </DialogHeader>
        <NameStep defaultName={channel.name} submitLabel="저장" pending={save.isPending} onSubmit={(name) => save.mutate(name)} />
      </DialogContent>
    </Dialog>
  );
}

function RulesTab() {
  const queryClient = useQueryClient();
  const rules = useQuery({ queryKey: ['rules'], queryFn: () => unwrap(api.GET('/api/v1/rules')) });
  const channels = useChannels();
  const [editing, setEditing] = useState<Rule | 'TECH_INTEREST' | 'PROJECT_IMPACT' | null>(null);
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['rules'] });
  const remove = useMutation({
    mutationFn: (id: string) => unwrap(api.DELETE('/api/v1/rules/{id}', { params: { path: { id } } })),
    onSuccess: invalidate,
    onError: (error) => toast.error(error.message),
  });
  const toggle = useMutation({
    mutationFn: (rule: Rule) =>
      unwrap(
        api.PUT('/api/v1/rules/{id}', {
          params: { path: { id: rule.id } },
          body: { name: rule.name, kind: rule.kind, projectIds: rule.projectIds, channelIds: rule.channelIds, schedule: rule.schedule, digestFormat: rule.digestFormat, template: rule.template, eventTypes: rule.eventTypes as EventType[], minSeverity: rule.minSeverity === 'UNKNOWN' ? null : rule.minSeverity, enabled: !rule.enabled },
        }),
      ),
    onSuccess: invalidate,
    onError: (error) => toast.error(error.message),
  });

  if (rules.isError) return <ErrorState error={rules.error} onRetry={() => rules.refetch()} />;
  if (!rules.data || !channels.data) return <LoadingState />;
  const channelName = (id: string) => channels.data.find((channel) => channel.id === id)?.name ?? '(삭제된 채널)';
  const noChannels = channels.data.length === 0;

  const section = (kind: 'TECH_INTEREST' | 'PROJECT_IMPACT', title: string, description: string) => {
    const items = rules.data.filter((rule) => rule.kind === kind);
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between gap-2">
            {title}
            <Button size="sm" disabled={noChannels} onClick={() => setEditing(kind)}>
              <Plus aria-hidden /> 규칙 추가
            </Button>
          </CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent>
          {items.length === 0 ? (
            <p className="text-sm text-muted-foreground">규칙이 없습니다.</p>
          ) : (
            <ul className="space-y-3">
              {items.map((rule) => (
                <li key={rule.id} className="rounded-md border p-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">{rule.name}</span>
                    <div className="flex items-center gap-2">
                      <Label htmlFor={`rule-${rule.id}`} className="text-xs text-muted-foreground">
                        {rule.enabled ? '켜짐' : '꺼짐'}
                      </Label>
                      <Switch id={`rule-${rule.id}`} checked={rule.enabled} onCheckedChange={() => toggle.mutate(rule)} />
                      <Button size="sm" variant="ghost" onClick={() => setEditing(rule)} aria-label={`${rule.name} 규칙 수정`}>
                        <Pencil aria-hidden />
                      </Button>
                      <Button size="sm" variant="ghost" className="text-destructive" onClick={() => remove.mutate(rule.id)} aria-label={`${rule.name} 규칙 삭제`}>
                        <Trash2 aria-hidden />
                      </Button>
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {rule.eventTypes.map((type) => (
                      <Badge key={type} variant="secondary">
                        {EVENT_LABEL[type]}
                      </Badge>
                    ))}
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {rule.scheduleText}{rule.digestFormat === 'BRIEFING' && rule.schedule.type !== 'IMMEDIATE' ? ' 보안 브리핑' : ''} · 문구 {rule.template ? '직접 정함' : '기본'} · 심각도 {rule.minSeverity ? `${SEVERITY_LABEL[rule.minSeverity]} 이상 (미제공 포함)` : '제한 없음'} · 채널{' '}
                    {rule.channelIds.map(channelName).join(', ')}
                    {kind === 'PROJECT_IMPACT' ? ` · 프로젝트 ${rule.projectIds.length ? `${rule.projectIds.length}개 지정` : '전체'}` : ''}
                  </p>
                  {rule.warnings.length > 0 ? (
                    <ul className="mt-2 list-disc pl-4 text-xs text-amber-700 dark:text-amber-400">
                      {rule.warnings.map((warning) => (
                        <li key={warning}>{warning}</li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    );
  };

  return (
    <div className="space-y-4">
      {noChannels ? (
        <Alert>
          <AlertTitle>먼저 채널을 등록하세요</AlertTitle>
          <AlertDescription>규칙은 알림을 보낼 채널이 하나 이상 있어야 만들 수 있습니다.</AlertDescription>
        </Alert>
      ) : null}
      {section(
        'TECH_INTEREST',
        '관심 기술 알림',
        '저장된 관심 기술과 일치하는 공지를 알립니다. 관련 공지일 뿐이며 프로젝트가 영향받는다는 뜻이 아닙니다. 피드 화면의 임시 필터는 이 조건을 바꾸지 않습니다.',
      )}
      {section(
        'PROJECT_IMPACT',
        '프로젝트 영향 알림',
        '프로젝트의 설치 버전이 공지의 영향 범위에 포함될 때 알립니다. 프로젝트를 처음 검사할 때는 기존 항목을 하나씩 보내지 않고 요약 한 건으로 알립니다.',
      )}
      {editing ? (
        <RuleDialog
          rule={typeof editing === 'string' ? null : editing}
          kind={typeof editing === 'string' ? editing : editing.kind}
          channels={channels.data}
          onClose={() => setEditing(null)}
          onSaved={invalidate}
        />
      ) : null}
    </div>
  );
}

function RuleDialog({ rule, kind, channels, onClose, onSaved }: { rule: Rule | null; kind: 'TECH_INTEREST' | 'PROJECT_IMPACT'; channels: Channel[]; onClose: () => void; onSaved: () => void }) {
  const projects = useProjects();
  const interests = useInterests();
  const events = kind === 'TECH_INTEREST' ? TECH_EVENTS : PROJECT_EVENTS;
  const [name, setName] = useState(rule?.name ?? (kind === 'TECH_INTEREST' ? '관심 기술 신규 취약점' : '프로젝트 영향'));
  const [eventTypes, setEventTypes] = useState<EventType[]>((rule?.eventTypes as EventType[]) ?? (kind === 'TECH_INTEREST' ? ['TECH_NEW_VULN', 'KEV_ADDED'] : ['PROJECT_NEW_MATCH', 'PRIORITY_RAISED', 'KEV_ADDED', 'INITIAL_SCAN_SUMMARY']));
  const [minSeverity, setMinSeverity] = useState<string>(rule?.minSeverity ?? (kind === 'TECH_INTEREST' ? 'HIGH' : ''));
  const [schedule, setSchedule] = useState<ScheduleValue>((rule?.schedule as ScheduleValue | undefined) ?? { type: 'IMMEDIATE' });
  const [digestFormat, setDigestFormat] = useState<'LIST' | 'BRIEFING'>(rule?.digestFormat ?? 'LIST');
  const [template, setTemplate] = useState<string | null>(rule?.template ?? null);
  const [channelIds, setChannelIds] = useState<string[]>(rule?.channelIds ?? (channels[0] ? [channels[0].id] : []));
  const [projectIds, setProjectIds] = useState<string[]>(rule?.projectIds ?? []);
  const toggleIn = <T,>(items: T[], item: T) => (items.includes(item) ? items.filter((x) => x !== item) : [...items, item]);

  const save = useMutation({
    mutationFn: () => {
      const body: RuleInput = {
        name,
        kind,
        eventTypes,
        minSeverity: (minSeverity || null) as RuleInput['minSeverity'],
        projectIds: kind === 'PROJECT_IMPACT' ? projectIds : [],
        schedule,
        digestFormat: schedule.type === 'IMMEDIATE' ? 'LIST' : digestFormat,
        template,
        channelIds,
        enabled: rule?.enabled ?? true,
      };
      return rule ? unwrap(api.PUT('/api/v1/rules/{id}', { params: { path: { id: rule.id } }, body })) : unwrap(api.POST('/api/v1/rules', { body }));
    },
    onSuccess: () => {
      onSaved();
      onClose();
      toast.success('규칙을 저장했습니다.');
    },
    onError: (error) => toast.error(error.message),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{kind === 'TECH_INTEREST' ? '관심 기술 알림 규칙' : '프로젝트 영향 알림 규칙'}</DialogTitle>
          <DialogDescription>같은 내용의 알림은 채널·취약점·프로젝트·변경 내용을 기준으로 한 번만 보냅니다.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4 text-sm">
          {kind === 'TECH_INTEREST' && interests.data?.technologyIds.length === 0 ? (
            <Alert>
              <AlertTitle>저장된 관심 기술이 없습니다</AlertTitle>
              <AlertDescription>
                관심 기술을 저장해야 이 규칙으로 알림이 발송됩니다.{' '}
                <Link to="/interests" className="underline underline-offset-2">
                  관심 기술 설정
                </Link>
              </AlertDescription>
            </Alert>
          ) : null}
          <div className="space-y-1.5">
            <Label htmlFor="rule-name">이름</Label>
            <Input id="rule-name" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <fieldset className="space-y-2">
            <legend className="font-medium">알릴 변화</legend>
            {events.map((type) => (
              <div key={type} className="flex items-center gap-2">
                <Checkbox id={`ev-${type}`} checked={eventTypes.includes(type)} onCheckedChange={() => setEventTypes((current) => toggleIn(current, type))} />
                <Label htmlFor={`ev-${type}`} className="font-normal">
                  {EVENT_LABEL[type]}
                </Label>
              </div>
            ))}
          </fieldset>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="rule-sev">심각도 기준</Label>
              <NativeSelect id="rule-sev" value={minSeverity} onChange={(e) => setMinSeverity(e.target.value)}>
                <option value="">제한 없음</option>
                <option value="CRITICAL">치명적만</option>
                <option value="HIGH">높음 이상</option>
                <option value="MEDIUM">보통 이상</option>
                <option value="LOW">낮음 이상</option>
              </NativeSelect>
              <p className="text-xs text-muted-foreground">심각도가 제공되지 않은 공지는 기준과 무관하게 포함됩니다.</p>
            </div>
            <SchedulePicker value={schedule} onChange={setSchedule} idPrefix="rule" />
          </div>
          {schedule.type !== 'IMMEDIATE' ? (
            <div className="space-y-2">
              <Label htmlFor="rule-format">모아 받는 형식</Label>
              <NativeSelect id="rule-format" value={digestFormat} onChange={(e) => setDigestFormat(e.target.value as 'LIST' | 'BRIEFING')}>
                <option value="LIST">알림 목록 - 새 알림이 있을 때만 제목을 모아 보냄</option>
                <option value="BRIEFING">보안 브리핑 - 받는 시각마다 현황을 정리해 보냄</option>
              </NativeSelect>
              {digestFormat === 'BRIEFING' ? (
                <p className="text-xs text-muted-foreground">
                  받는 시각에 따라 아침(밤사이 발생분), 오후(오늘 발생분), 주말 브리핑으로 보냅니다. 지난 브리핑 이후 새 이슈와 KEV 등재 여부, 프로젝트 영향, 재검사로 확인된 패치, 조치 완료로 바꿨지만 아직 재검사로 확인되지 않은 항목, 국내 보안공지를 담습니다. 새 이슈가 없어도 보내고, 보낸 브리핑은 보안 브리핑 메뉴에 남습니다.
                </p>
              ) : null}
            </div>
          ) : null}
          <fieldset className="space-y-2">
            <legend className="font-medium">보낼 채널</legend>
            {channels.map((channel) => (
              <div key={channel.id} className="flex items-center gap-2">
                <Checkbox id={`rc-${channel.id}`} checked={channelIds.includes(channel.id)} onCheckedChange={() => setChannelIds((current) => toggleIn(current, channel.id))} />
                <Label htmlFor={`rc-${channel.id}`} className="font-normal">
                  {channel.name} <span className="text-muted-foreground">({channel.type === 'TELEGRAM' ? 'Telegram' : 'Discord'})</span>
                </Label>
              </div>
            ))}
          </fieldset>
          {kind === 'PROJECT_IMPACT' ? (
            <fieldset className="space-y-2">
              <legend className="font-medium">대상 프로젝트</legend>
              <p className="text-xs text-muted-foreground">아무것도 고르지 않으면 내 모든 프로젝트가 대상입니다.</p>
              {(projects.data ?? []).map((project) => (
                <div key={project.id} className="flex items-center gap-2">
                  <Checkbox id={`rp-${project.id}`} checked={projectIds.includes(project.id)} onCheckedChange={() => setProjectIds((current) => toggleIn(current, project.id))} />
                  <Label htmlFor={`rp-${project.id}`} className="font-normal">
                    {project.name}
                  </Label>
                </div>
              ))}
            </fieldset>
          ) : null}
          <fieldset className="space-y-2 border-t pt-4">
            <legend className="sr-only">알림 문구</legend>
            <TemplateEditor kind={kind} value={template} onChange={setTemplate} />
          </fieldset>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              취소
            </Button>
            <Button type="submit" disabled={save.isPending || eventTypes.length === 0 || channelIds.length === 0}>
              저장
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ScheduleTab() {
  const queryClient = useQueryClient();
  const me = useMe();
  const [form, setForm] = useState<Schemas['UserSettingsDto'] | null>(null);
  useEffect(() => {
    if (me.data && form === null) setForm(me.data.settings);
  }, [me.data, form]);
  const save = useMutation({
    mutationFn: () => {
      const { timezone, quietHoursEnabled, quietStartMinute, quietEndMinute, urgentBypassQuiet } = form!;
      return unwrap(api.PATCH('/api/v1/me/settings', { body: { timezone, quietHoursEnabled, quietStartMinute, quietEndMinute, urgentBypassQuiet } }));
    },
    onSuccess: (settings) => {
      queryClient.setQueryData(ME_KEY, (current: typeof me.data) => (current ? { ...current, settings } : current));
      setForm(settings);
      toast.success('저장했습니다.');
    },
    onError: (error) => toast.error(error.message),
  });
  if (!form) return <LoadingState />;
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm({ ...form, [key]: value });
  const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [form.timezone];

  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle>시간대와 방해 금지 시간</CardTitle>
        <CardDescription>
          모든 알림 시각은 이 시간대를 기준으로 합니다. 규칙마다 받는 시간(즉시·매일·매주·N시간마다)은 구독 규칙에서 정합니다. 방해 금지 시간에 생긴 알림은 보류했다가 시간이 끝나면 보냅니다.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4 text-sm"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="tz">시간대</Label>
            <NativeSelect id="tz" value={form.timezone} onChange={(e) => set('timezone', e.target.value)}>
              {(zones.includes(form.timezone) ? zones : [form.timezone, ...zones]).map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
            </NativeSelect>
          </div>

          <div className="flex items-center gap-2">
            <Switch id="quiet" checked={form.quietHoursEnabled} onCheckedChange={(checked) => set('quietHoursEnabled', checked)} />
            <Label htmlFor="quiet">방해 금지 시간 사용</Label>
          </div>
          <div className="grid max-w-sm grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="quiet-start">시작</Label>
              <Input id="quiet-start" type="time" disabled={!form.quietHoursEnabled} value={minutesToTime(form.quietStartMinute)} onChange={(e) => set('quietStartMinute', timeToMinutes(e.target.value))} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="quiet-end">끝</Label>
              <Input id="quiet-end" type="time" disabled={!form.quietHoursEnabled} value={minutesToTime(form.quietEndMinute)} onChange={(e) => set('quietEndMinute', timeToMinutes(e.target.value))} />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Switch id="bypass" disabled={!form.quietHoursEnabled} checked={form.urgentBypassQuiet} onCheckedChange={(checked) => set('urgentBypassQuiet', checked)} />
            <Label htmlFor="bypass">긴급 알림은 방해 금지 시간에도 보내기</Label>
          </div>
          <Button type="submit" disabled={save.isPending}>
            저장
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
