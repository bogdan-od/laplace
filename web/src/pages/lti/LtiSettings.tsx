import { useState, type SubmitEvent } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import type { CreateLtiPlatformBody, LtiPlatform } from "@shared/api";
import { Field } from "@/components/Field";
import { PendingButton } from "@/components/PendingButton";
import { Button } from "@/components/ui/button";
import { api, describeError, ApiFailure } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { apiQuery, invalidateRoute } from "@/lib/query";
import { hasErrors, splitFieldMessage, type FieldErrors } from "@/lib/validate";
import { checkPlatform, EMPTY_PLATFORM, PLATFORM_FIELDS, trimmed, type PlatformField } from "./platform-form";

/** The "LMS (LTI 1.3)" settings of a teacher: addresses for the LMS, assignment ids, registered platforms. */
export function LtiSettings() {
  return (
    <div className="flex flex-col gap-5" data-testid="lti-settings">
      <ToolAddresses />
      <AssignmentIds />
      <Platforms />
      <PlatformForm />
    </div>
  );
}

function CopyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[13px] text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 rounded-md bg-muted px-2 py-1 text-[13px] break-all">{value}</code>
        <Button type="button" size="xs" variant="outline" onClick={() => void copyText(value, "Скопійовано")}>
          Копіювати
        </Button>
      </div>
    </div>
  );
}

function ToolAddresses() {
  const tool = useQuery(apiQuery("GET /api/lti/tool"));
  if (tool.error) return <p className="text-[13px] text-destructive">{describeError(tool.error)}</p>;
  if (!tool.data) return null;
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">Адреси для налаштувань інструменту в LMS</h3>
      <CopyRow label="Адреса входу (login URL)" value={tool.data.login_url} />
      <CopyRow label="Адреса перенаправлення (redirect URL)" value={tool.data.launch_url} />
      <CopyRow label="Адреса набору ключів (JWKS)" value={tool.data.jwks_url} />
    </div>
  );
}

function AssignmentIds() {
  const classes = useQuery(apiQuery("GET /api/classes"));
  const owned = (classes.data ?? []).filter((klass) => klass.my_role === "owner");
  const details = useQueries({
    queries: owned.map((klass) => apiQuery("GET /api/classes/:id", { params: { id: klass.id } })),
  });
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">Завдання для LMS</h3>
      <p className="text-[13px] text-muted-foreground">
        У налаштуваннях активності в LMS вкажіть параметр <code>assignment=&lt;id завдання&gt;</code>
      </p>
      {details.map((detail) =>
        detail.data === undefined ? null : (
          <div key={detail.data.id} className="flex flex-col gap-1">
            <span className="text-[13px] font-medium">{detail.data.name}</span>
            {detail.data.assignments.length === 0 && <span className="text-[13px] text-muted-foreground">Завдань ще немає</span>}
            {detail.data.assignments.map((assignment) => (
              <div key={assignment.id} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm">{assignment.title}</span>
                <code className="rounded-md bg-muted px-2 py-0.5 text-[13px]">assignment={assignment.id}</code>
                <Button type="button" size="xs" variant="outline" onClick={() => void copyText(`assignment=${assignment.id}`, "Скопійовано")}>
                  Копіювати
                </Button>
              </div>
            ))}
          </div>
        ),
      )}
    </div>
  );
}

function Platforms() {
  const platforms = useQuery(apiQuery("GET /api/lti/platforms"));
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">Платформи</h3>
      {platforms.error && <p className="text-[13px] text-destructive">{describeError(platforms.error)}</p>}
      {platforms.data?.length === 0 && <p className="text-[13px] text-muted-foreground">Платформ ще не додано</p>}
      {platforms.data?.map((platform) => <PlatformRow key={platform.id} platform={platform} />)}
    </div>
  );
}

function PlatformRow({ platform }: { platform: LtiPlatform }) {
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);

  const remove = async () => {
    setPending(true);
    try {
      await api("DELETE /api/lti/platforms/:id", { params: { id: platform.id } });
      await invalidateRoute("GET /api/lti/platforms");
      toast.success("Платформу видалено");
    } catch (error) {
      toast.error(describeError(error));
      setConfirming(false);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex items-center gap-2" data-testid="lti-platform">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{platform.name}</div>
        <div className="truncate text-[13px] text-muted-foreground">{platform.issuer}</div>
      </div>
      {confirming ? (
        <PendingButton type="button" size="xs" variant="destructive" pending={pending} onClick={() => void remove()}>
          Підтвердити видалення
        </PendingButton>
      ) : (
        <Button type="button" size="xs" variant="outline" onClick={() => setConfirming(true)}>
          Видалити
        </Button>
      )}
    </div>
  );
}

function PlatformForm() {
  const [values, setValues] = useState<CreateLtiPlatformBody>(EMPTY_PLATFORM);
  const [errors, setErrors] = useState<FieldErrors<PlatformField>>({});
  const [pending, setPending] = useState(false);

  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const found = checkPlatform(values);
    setErrors(found);
    if (hasErrors(found)) return;
    setPending(true);
    try {
      await api("POST /api/lti/platforms", { body: trimmed(values) });
      await invalidateRoute("GET /api/lti/platforms");
      setValues(EMPTY_PLATFORM);
      toast.success("Платформу додано");
    } catch (error) {
      setErrors(serverErrors(error));
    } finally {
      setPending(false);
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} noValidate className="flex flex-col gap-3" data-testid="lti-platform-form">
      <h3 className="text-sm font-semibold">Додати платформу</h3>
      {PLATFORM_FIELDS.map(({ key, label }) => (
        <Field
          key={key}
          label={label}
          value={values[key]}
          error={errors[key]}
          onChange={(event) => {
            setValues({ ...values, [key]: event.target.value });
            setErrors({ ...errors, [key]: undefined, form: undefined });
          }}
        />
      ))}
      {errors.form && <p className="text-[13px] text-destructive">{errors.form}</p>}
      <PendingButton type="submit" pending={pending} className="self-start">
        Додати платформу
      </PendingButton>
    </form>
  );
}

function serverErrors(error: unknown): FieldErrors<PlatformField> {
  if (error instanceof ApiFailure && error.status === 400) {
    const field = splitFieldMessage(error.message);
    if (field !== null && PLATFORM_FIELDS.some(({ key }) => key === field.field)) {
      return { [field.field]: field.text } as FieldErrors<PlatformField>;
    }
  }
  return { form: describeError(error) };
}
