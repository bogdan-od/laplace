import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import type { ReviewItem, SubmissionSummary } from "@shared/api";
import { EmptyState } from "@/components/EmptyState";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { describeError } from "@/lib/api";
import { formatWhen } from "@/lib/format";
import { apiQuery } from "@/lib/query";
import { cn } from "@/lib/utils";
import { useHelpMoment } from "@/pages/student/use-help-moment";
import { submissionState } from "@/pages/work/verify-text";
import {
  filterReview,
  REVIEW_FILTERS,
  REVIEW_KIND_LABEL,
  reviewAt,
  reviewClasses,
  reviewKey,
  reviewStudentName,
  reviewTarget,
  reviewWhen,
  type ReviewFilter,
} from "./review-list";

const OPEN_LINK = "text-left font-medium text-primary hover:underline disabled:opacity-60";

function SubmissionState({ submission }: { submission: SubmissionSummary }) {
  const state = submissionState(submission);
  return (
    <span data-testid="review-verify" data-verify={submission.verify_status} className={cn("text-sm", state.tone)}>
      {state.text}
    </span>
  );
}

/** The link to the work of the item: a page for a submission, the moment of the request for a help request. */
function OpenLink({ item }: { item: ReviewItem }) {
  const { opening, open } = useHelpMoment();
  const target = reviewTarget(item);
  if (target.kind === "page") {
    return (
      <Link to={target.href} data-testid="review-open" className={OPEN_LINK}>
        {item.assignment.title}
      </Link>
    );
  }
  return (
    <button
      type="button"
      data-testid="review-open"
      disabled={opening === target.help.id}
      onClick={() => void open(target.help, true)}
      className={OPEN_LINK}
    >
      {item.assignment.title}
    </button>
  );
}

function ReviewRow({ item, now }: { item: ReviewItem; now: number }) {
  const at = reviewAt(item);
  return (
    <TableRow data-testid="review-row" data-kind={item.kind} data-key={reviewKey(item)}>
      <TableCell>
        <Badge variant={item.kind === "help" ? "destructive" : "secondary"}>{REVIEW_KIND_LABEL[item.kind]}</Badge>
      </TableCell>
      <TableCell>{reviewStudentName(item)}</TableCell>
      <TableCell className="whitespace-normal">
        <OpenLink item={item} />
      </TableCell>
      <TableCell>{item.class.name}</TableCell>
      <TableCell className="whitespace-nowrap text-muted-foreground" title={formatWhen(at, now)}>
        {reviewWhen(at, now)}
      </TableCell>
      <TableCell className="max-w-xs whitespace-normal">
        {item.kind === "submission" ? (
          <SubmissionState submission={item.submission} />
        ) : (
          <span className="line-clamp-2 text-sm text-muted-foreground">{item.help.text}</span>
        )}
      </TableCell>
    </TableRow>
  );
}

/** The row of the table on a narrow screen: the same fields and the same link, one card per item. */
function ReviewCard({ item, now }: { item: ReviewItem; now: number }) {
  const at = reviewAt(item);
  return (
    <li data-testid="review-card" data-kind={item.kind} data-key={reviewKey(item)} className="flex flex-col gap-1.5 px-3 py-3">
      <div className="flex items-center gap-2">
        <Badge variant={item.kind === "help" ? "destructive" : "secondary"}>{REVIEW_KIND_LABEL[item.kind]}</Badge>
        <span className="min-w-0 truncate font-medium">{reviewStudentName(item)}</span>
        <span className="ml-auto shrink-0 text-sm whitespace-nowrap text-muted-foreground" title={formatWhen(at, now)}>
          {reviewWhen(at, now)}
        </span>
      </div>
      <div className="flex flex-wrap items-baseline gap-x-2">
        <OpenLink item={item} />
        <span className="text-sm text-muted-foreground">{item.class.name}</span>
      </div>
      {item.kind === "submission" ? (
        <SubmissionState submission={item.submission} />
      ) : (
        <span className="line-clamp-2 text-sm text-muted-foreground">{item.help.text}</span>
      )}
    </li>
  );
}

/** A table on a wide screen, cards on a narrow one. */
function ReviewList({ shown, now }: { shown: readonly ReviewItem[]; now: number }) {
  return (
    <>
      <div className="hidden rounded-lg border bg-card md:block">
        <Table data-testid="review-table">
          <TableHeader>
            <TableRow>
              <TableHead>Вид</TableHead>
              <TableHead>Студент</TableHead>
              <TableHead>Завдання</TableHead>
              <TableHead>Клас</TableHead>
              <TableHead>Коли</TableHead>
              <TableHead>Стан</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((item) => (
              <ReviewRow key={reviewKey(item)} item={item} now={now} />
            ))}
          </TableBody>
        </Table>
      </div>
      <ul className="divide-y rounded-lg border bg-card md:hidden">
        {shown.map((item) => (
          <ReviewCard key={reviewKey(item)} item={item} now={now} />
        ))}
      </ul>
    </>
  );
}

/** "/review": ungraded submissions and open "не працює" requests of all my classes, newest first. */
export function ReviewPage() {
  const review = useQuery(apiQuery("GET /api/review"));
  const [filter, setFilter] = useState<ReviewFilter>("all");
  const [chosenClass, setChosenClass] = useState<number | null>(null);
  const [now] = useState(() => Date.now());

  let body;
  if (review.error) {
    body = (
      <EmptyState
        title={describeError(review.error)}
        action={<Button variant="outline" onClick={() => void review.refetch()}>Спробувати знову</Button>}
      />
    );
  } else if (!review.data) {
    body = <p className="text-sm text-muted-foreground">Завантаження…</p>;
  } else if (review.data.length === 0) {
    body = (
      <div className="rounded-lg border bg-card">
        <EmptyState title="Все перевірено." hint="Нові здачі з'являться тут." />
      </div>
    );
  } else {
    const classes = reviewClasses(review.data);
    const classId = classes.some((klass) => klass.id === chosenClass) ? chosenClass : null;
    const shown = filterReview(review.data, filter, classId);
    body = (
      <>
        <div className="flex flex-wrap items-center gap-3">
          <Tabs value={filter} onValueChange={(value) => setFilter(value as ReviewFilter)}>
            <TabsList variant="line" data-testid="review-filter" className="h-auto justify-start">
              {REVIEW_FILTERS.map((option) => (
                <TabsTrigger key={option.value} value={option.value} data-testid="review-tab" data-kind={option.value} className="flex-none px-3">
                  {option.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          {classes.length > 1 && (
            <select
              aria-label="Клас"
              data-testid="review-class"
              className="ml-auto h-8 rounded-lg border border-input bg-background px-2.5 text-sm"
              value={classId ?? ""}
              onChange={(event) => setChosenClass(event.target.value === "" ? null : Number(event.target.value))}
            >
              <option value="">Усі класи</option>
              {classes.map((klass) => (
                <option key={klass.id} value={klass.id}>
                  {klass.name}
                </option>
              ))}
            </select>
          )}
        </div>
        {shown.length === 0 ? (
          <div className="rounded-lg border bg-card">
            <EmptyState title="Нічого не знайдено" hint="Змініть вид або клас." />
          </div>
        ) : (
          <ReviewList shown={shown} now={now} />
        )}
      </>
    );
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4 px-4 sm:px-6 py-6" data-testid="review-page">
      <h1 className="font-display text-[26px] leading-tight font-bold">На перевірку</h1>
      {body}
    </div>
  );
}
