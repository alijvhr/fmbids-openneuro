import { builder } from "../builder"
import { PageInfo } from "./pagination"
import {
  fairMBidsLinkedSubjects,
  fairMBidsSubjects,
} from "../resolvers/fairmbids-search"
import type { FairMBidsFilter } from "../resolvers/build-fairmbids-search-query"

const IntRange = builder.inputType("FAIRMBIDSIntRange", {
  fields: (t) => ({ gte: t.int(), lte: t.int() }),
})

const FloatRange = builder.inputType("FAIRMBIDSFloatRange", {
  fields: (t) => ({ gte: t.float(), lte: t.float() }),
})

const SessionPredicate = builder.inputType("FAIRMBIDSSessionPredicate", {
  description: "Conditions that must all hold within one session",
  fields: (t) => ({
    sessionId: t.string({ description: "BIDS session label, e.g. ses-01" }),
    order: t.field({
      type: IntRange,
      description: "Chronological position from sessions.tsv acq_time (1 = first)",
    }),
    relativeDay: t.field({
      type: IntRange,
      description: "Days since the subject's first session",
    }),
    modalitiesAll: t.stringList(),
    modalitiesAny: t.stringList(),
  }),
})

const Transition = builder.inputType("FAIRMBIDSTransition", {
  fields: (t) => ({
    from: t.field({ type: SessionPredicate, required: true }),
    to: t.field({ type: SessionPredicate, required: true }),
    minDeltaDays: t.int(),
    maxDeltaDays: t.int(),
  }),
})

const MetadataField = builder.enumType("FAIRMBIDSMetadataField", {
  values: ["AGE", "SEX", "SESSION_TIME", "MODALITY"] as const,
})

const FilterInput = builder.inputRef<FairMBidsFilter>("FAIRMBIDSFilter")
FilterInput.implement({
  description: "All present conditions must hold for the same subject",
  fields: (t) => ({
    subject: t.field({
      type: builder.inputType("FAIRMBIDSSubjectFilter", {
        fields: (t) => ({
          datasetIds: t.stringList(),
          sex: t.stringList(),
          age: t.field({ type: FloatRange }),
          groups: t.stringList({ description: "participants.tsv group values" }),
        }),
      }),
    }),
    longitudinal: t.field({
      type: builder.inputType("FAIRMBIDSLongitudinalFilter", {
        fields: (t) => ({
          minSessions: t.int(),
          maxSessions: t.int(),
          minSpanDays: t.int(),
          maxSpanDays: t.int(),
          hasSessions: t.field({ type: [SessionPredicate] }),
          missingSessions: t.field({ type: [SessionPredicate] }),
          transition: t.field({ type: Transition }),
        }),
      }),
    }),
    multimodal: t.field({
      type: builder.inputType("FAIRMBIDSMultimodalFilter", {
        fields: (t) => ({
          anywhereAll: t.stringList(),
          anywhereAny: t.stringList(),
          sameSessionAll: t.stringList(),
          distinctSessions: t.stringList({ description: "Exactly two modalities" }),
          everySessionAll: t.stringList(),
        }),
      }),
    }),
    repeatedModality: t.field({
      type: builder.inputType("FAIRMBIDSRepeatedModality", {
        fields: (t) => ({
          modality: t.string({ required: true }),
          minSessions: t.int({ required: true }),
        }),
      }),
    }),
    completeness: t.field({
      type: builder.inputType("FAIRMBIDSCompleteness", {
        fields: (t) => ({ required: t.field({ type: [MetadataField], required: true }) }),
      }),
    }),
    and: t.field({ type: [FilterInput] }),
    or: t.field({ type: [FilterInput] }),
    not: t.field({ type: FilterInput }),
  }),
})

const Session = builder.simpleObject("FAIRMBIDSSession", {
  fields: (t) => ({
    sessionId: t.string({ nullable: true, description: "Null for a subject without sessions" }),
    sessionOrder: t.int({ nullable: true }),
    relativeTimeDays: t.int({ nullable: true }),
    modalities: t.stringList(),
  }),
})

const Subject = builder.simpleObject("FAIRMBIDSSubject", {
  fields: (t) => ({
    subjectKey: t.id(),
    datasetId: t.id(),
    snapshotTag: t.string(),
    participantId: t.string(),
    age: t.float({ nullable: true }),
    sex: t.string({ nullable: true }),
    group: t.string({ nullable: true }),
    sessionCount: t.int(),
    spanDays: t.int({ nullable: true }),
    modalities: t.stringList(),
    sessions: t.field({ type: [Session] }),
  }),
})

const SubjectEdge = builder.simpleObject("FAIRMBIDSSubjectEdge", {
  fields: (t) => ({
    cursor: t.string(),
    node: t.field({ type: Subject }),
  }),
})

const FacetBucket = builder.simpleObject("FAIRMBIDSFacetBucket", {
  fields: (t) => ({ value: t.string(), count: t.int() }),
})

const Facets = builder.simpleObject("FAIRMBIDSFacets", {
  description: "Subject counts within the filtered result",
  fields: (t) => ({
    modalities: t.field({ type: [FacetBucket] }),
    sexes: t.field({ type: [FacetBucket] }),
    groups: t.field({ type: [FacetBucket] }),
    sessionCounts: t.field({ type: [FacetBucket] }),
  }),
})

const SubjectConnection = builder.simpleObject("FAIRMBIDSSubjectConnection", {
  fields: (t) => ({
    edges: t.field({ type: [SubjectEdge] }),
    pageInfo: t.field({ type: PageInfo }),
    facets: t.field({ type: Facets, nullable: true }),
  }),
})

builder.queryFields((t) => ({
  fairMBidsSubjects: t.field({
    type: SubjectConnection,
    description: "Search FAIR m-BIDS subjects of readable datasets",
    args: {
      filter: t.arg({ type: FilterInput, required: true }),
      first: t.arg.int(),
      after: t.arg.string(),
      facets: t.arg.boolean(),
    },
    resolve: (root, args, ctx) => fairMBidsSubjects(root, args as never, ctx) as never,
  }),
}))

const LinkedMember = builder.simpleObject("FAIRMBIDSLinkedMember", {
  fields: (t) => ({
    datasetId: t.id(),
    participantId: t.string(),
    modalities: t.stringList(),
  }),
})

const LinkedSubject = builder.simpleObject("FAIRMBIDSLinkedSubject", {
  description: "Dataset-local subjects sharing one GSId; the GSId itself is never returned",
  fields: (t) => ({
    linkedSubjectRef: t.id({ description: "Opaque, valid only within this response" }),
    members: t.field({ type: [LinkedMember] }),
  }),
})

const LinkedSubjectConnection = builder.simpleObject("FAIRMBIDSLinkedSubjectConnection", {
  fields: (t) => ({
    edges: t.field({
      type: [builder.simpleObject("FAIRMBIDSLinkedSubjectEdge", {
        fields: (t) => ({ node: t.field({ type: LinkedSubject }) }),
      })],
    }),
    pageInfo: t.field({ type: PageInfo }),
  }),
})

builder.queryFields((t) => ({
  fairMBidsLinkedSubjects: t.field({
    type: LinkedSubjectConnection,
    description: "Admin only: subjects linked across datasets by GSId",
    args: {
      datasetIds: t.arg.stringList(),
      minDatasets: t.arg.int(),
      modalitiesAll: t.arg.stringList(),
      first: t.arg.int(),
      after: t.arg.string(),
    },
    resolve: (root, args, ctx) => fairMBidsLinkedSubjects(root, args as never, ctx) as never,
  }),
}))
