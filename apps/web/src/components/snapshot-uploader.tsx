import { LOCKFILE_FORMAT_LABEL } from '@/components/github-import';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FileUp, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { api, unwrap, type Schemas } from '@/lib/api';

type SnapshotInput = Schemas['SnapshotInputDto'];
type Preview = Schemas['SnapshotPreviewDto'];
interface Warning {
  code: string;
  message: string;
  count: number;
  examples: string[];
}

const MAX_BYTES = 20 * 1024 * 1024;

/** "name@1.2.3" 줄 목록을 해석한다. 스코프 패키지(@scope/name@1.2.3)를 고려해 마지막 @ 로 나눈다. */
export function parseManualLines(text: string): { packages: Array<{ name: string; version: string }>; errors: string[] } {
  const packages: Array<{ name: string; version: string }> = [];
  const errors: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const at = line.lastIndexOf('@');
    if (at <= 0) {
      errors.push(line);
      continue;
    }
    packages.push({ name: line.slice(0, at).trim(), version: line.slice(at + 1).trim() });
  }
  return { packages, errors };
}

export function SnapshotUploader({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const [input, setInput] = useState<SnapshotInput | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [manualText, setManualText] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const [lockName, setLockName] = useState('');
  const [packageJson, setPackageJson] = useState<string | null>(null);
  const [lockContent, setLockContent] = useState<string | null>(null);

  const validate = useMutation({
    mutationFn: (body: SnapshotInput) => unwrap(api.POST('/api/v1/projects/{id}/snapshots/validate', { params: { path: { id: projectId } }, body })),
    onSuccess: (result, body) => {
      setPreview(result);
      setInput(result.valid ? body : null);
    },
    onError: (error) => setLocalError(error.message),
  });

  const create = useMutation({
    mutationFn: (body: SnapshotInput) => unwrap(api.POST('/api/v1/projects/{id}/snapshots', { params: { path: { id: projectId } }, body })),
    onSuccess: () => {
      toast.success('구성을 저장하고 검사를 시작했습니다.');
      setInput(null);
      setPreview(null);
      setManualText('');
      setLockContent(null);
      setPackageJson(null);
      setLockName('');
      void queryClient.invalidateQueries({ queryKey: ['project', projectId] });
      void queryClient.invalidateQueries({ queryKey: ['snapshots', projectId] });
      void queryClient.invalidateQueries({ queryKey: ['scans', projectId] });
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
    onError: (error) => toast.error(error.message),
  });

  // 파일은 브라우저에서 텍스트로만 읽어 보낸다. 서버는 JSON 으로 해석할 뿐 실행하지 않는다.
  const readFile = async (file: File | undefined, target: 'lock' | 'package') => {
    setLocalError(null);
    setPreview(null);
    setInput(null);
    if (!file) return;
    if (file.size > MAX_BYTES) {
      setLocalError(`파일이 너무 큽니다 (최대 ${MAX_BYTES / 1024 / 1024}MB).`);
      return;
    }
    const text = await file.text();
    if (target === 'lock') {
      setLockContent(text);
      setLockName(file.name);
    } else setPackageJson(text);
  };

  const validateLockfile = () => {
    if (!lockContent) return;
    setLocalError(null);
    validate.mutate({ inputType: 'LOCKFILE', fileName: lockName, lockfileContent: lockContent, ...(packageJson ? { packageJsonContent: packageJson } : {}) });
  };

  const validateManual = () => {
    setLocalError(null);
    setPreview(null);
    const { packages, errors } = parseManualLines(manualText);
    if (errors.length > 0) {
      setLocalError(`"이름@버전" 형식이 아닌 줄이 있습니다: ${errors.slice(0, 3).join(', ')}`);
      return;
    }
    validate.mutate({ inputType: 'MANUAL', packages });
  };

  const warnings = (preview?.warnings ?? []) as unknown as Warning[];

  return (
    <div className="space-y-4">
      <Tabs defaultValue="lockfile" onValueChange={() => { setPreview(null); setInput(null); setLocalError(null); }}>
        <TabsList>
          <TabsTrigger value="lockfile">lockfile 업로드</TabsTrigger>
          <TabsTrigger value="manual">패키지 직접 입력</TabsTrigger>
        </TabsList>
        <TabsContent value="lockfile" className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="lockfile">package-lock.json, pnpm-lock.yaml, yarn.lock</Label>
              <Input id="lockfile" type="file" accept=".json,.yaml,.yml,.lock,application/json" onChange={(e) => void readFile(e.target.files?.[0], 'lock')} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="packagejson">package.json (선택)</Label>
              <Input id="packagejson" type="file" accept=".json,application/json" onChange={(e) => void readFile(e.target.files?.[0], 'package')} />
              <p className="text-xs text-muted-foreground">lockfile 과의 불일치 확인에만 씁니다. yarn.lock(Yarn 1)은 이 파일이 있어야 직접 의존성을 구분합니다.</p>
            </div>
          </div>
          <Button variant="outline" disabled={!lockContent || validate.isPending} onClick={validateLockfile}>
            <ShieldCheck aria-hidden /> 내용 확인
          </Button>
        </TabsContent>
        <TabsContent value="manual" className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="manual">한 줄에 하나씩 "패키지명@정확한 버전"</Label>
            <Textarea id="manual" rows={6} className="font-mono text-xs" placeholder={'lodash@4.17.20\n@nestjs/core@10.3.0'} value={manualText} onChange={(e) => setManualText(e.target.value)} />
            <p className="text-xs text-muted-foreground">^1.2.0, ~1.2, 1.x 같은 범위는 설치 버전이 아니므로 받지 않습니다. 직접 입력하면 전이 의존성은 포함되지 않습니다.</p>
          </div>
          <Button variant="outline" disabled={!manualText.trim() || validate.isPending} onClick={validateManual}>
            <ShieldCheck aria-hidden /> 내용 확인
          </Button>
        </TabsContent>
      </Tabs>

      {localError ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>확인할 수 없습니다</AlertTitle>
          <AlertDescription>{localError}</AlertDescription>
        </Alert>
      ) : null}

      {preview && !preview.valid ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>지원하지 않거나 올바르지 않은 입력입니다</AlertTitle>
          <AlertDescription>{preview.error}</AlertDescription>
        </Alert>
      ) : null}

      {preview?.valid ? (
        <div className="space-y-3 rounded-lg border p-4">
          <h3 className="text-sm font-medium">확인 결과</h3>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
            {preview.lockfileVersion ? (
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">형식</dt>
                <dd className="tabular-nums">{preview.lockfileFormat ? `${LOCKFILE_FORMAT_LABEL[preview.lockfileFormat]} · ` : ''}v{preview.lockfileVersion}</dd>
              </div>
            ) : null}
            {[
              ['설치 항목', preview.packageCount],
              ['검사 가능', preview.scannableCount],
              ['검사 불가', preview.packageCount - preview.scannableCount],
              ['직접 의존성', preview.directCount],
              ['개발 의존성', preview.devCount],
              ['여러 버전으로 설치된 패키지', preview.multiVersionCount],
            ].map(([label, count]) => (
              <div key={label} className="flex justify-between gap-2">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="tabular-nums">{Number(count).toLocaleString('ko-KR')}</dd>
              </div>
            ))}
          </dl>
          {warnings.length > 0 ? (
            <div>
              <p className="text-sm font-medium">검사하지 못하거나 주의할 항목</p>
              <ul className="mt-1 space-y-1 text-xs">
                {warnings.map((warning) => (
                  <li key={`${warning.code}-${warning.message}`}>
                    <span className="font-medium">{warning.message}</span> - {warning.count}건
                    <span className="text-muted-foreground"> (예: {warning.examples.join(', ')})</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <Alert>
            <AlertTitle>외부로 전송되는 정보</AlertTitle>
            <AlertDescription>
              {preview.disclosure} 업로드한 구성이 실제 운영에 배포된 구성과 같다고 가정하지 않습니다 - 운영 중인 lockfile 을 올려야 결과가 의미 있습니다.
            </AlertDescription>
          </Alert>
          <Button disabled={!input || create.isPending} onClick={() => input && create.mutate(input)}>
            <FileUp aria-hidden /> 이 구성으로 저장하고 검사 시작
          </Button>
        </div>
      ) : null}
    </div>
  );
}
