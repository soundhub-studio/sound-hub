import "dotenv/config";
import express, { type Application, type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import helmet from "helmet";
import { createPrismaClient, type PrismaClient } from "@soundhub/db";
import { healthRoutes } from "./routes/health.js";
import { createSearchRouter } from "./routes/search.js";
import { createMetadataRouter } from "./routes/metadata.js";
import { createAuthRouter } from "./routes/auth.js";
import { createAudioSamplesRouter } from "./routes/audio-samples.js";
import { createOfferingCatalogRouter } from "./routes/offering-catalog.js";
import { createMatchmakerRouter } from "./routes/matchmaker.js";
import { createIntentRouter } from "./routes/intent.js";
import { createSellerProfileRouter } from "./routes/seller-profile.js";
import { createServiceOfferingRouter } from "./routes/service-offering.js";
import { PrismaOfferingCatalogRepository } from "./repositories/prisma-offering-catalog.repository.js";
import { PrismaServiceOfferingRepository } from "./repositories/prisma-service-offering.repository.js";
import type { ServiceOfferingRepository } from "./repositories/service-offering.repository.js";
import { createProjectRequestRouter } from "./routes/project-requests.js";
import { createDealTermsRouter } from "./routes/deal-terms.js";
import { createDealListRouter } from "./routes/deal-list.js";
import { PrismaFundingRepository } from "./funding/prisma-funding.repository.js";
import { FundingService } from "./funding/funding.service.js";
import { DeterministicMockEscrowProvider } from "./escrow/escrow-provider.js";
import { createBg6FundingRouter } from "./routes/funding.js";
import { TalentSearchService } from "./services/talent-search.service.js";
import { AuthenticationService } from "./services/authentication.service.js";
import { WorkspaceAuthorizationService } from "./services/workspace-authorization.service.js";
import { PersonalWorkspaceConvergenceService } from "./services/personal-workspace-convergence.service.js";
import { IntentService } from "./services/intent.service.js";
import { SellerProfileService } from "./services/seller-profile.service.js";
import { ServiceOfferingService } from "./services/service-offering.service.js";
import { AudioSampleService } from "./services/audio-sample.service.js";
import { MatchmakerService } from "./services/matchmaker.service.js";
import { ProjectRequestService } from "./project-request/project-request.service.js";
import { PrismaTalentSearchRepository } from "./repositories/prisma-talent-search.repository.js";
import { PrismaMetadataRepository } from "./repositories/prisma-metadata.repository.js";
import { PrismaAuthRepository } from "./auth-repository/prisma-auth-repository.js";
import { PrismaAudioRepository } from "./audio-repository/prisma-audio-repository.js";
import { PrismaProjectBriefRepository } from "./matchmaker/prisma-project-brief.repository.js";
import { PrismaProjectRequestRepository } from "./project-request/prisma-project-request.repository.js";
import { PrismaDealTermsRepository } from "./deal-terms/prisma-deal-terms.repository.js";
import { DealTermsService } from "./deal-terms/deal-terms.service.js";
import { DealApproverService } from "./deal-approver/deal-approver.service.js";
import { PrismaDealApproverRepository } from "./deal-approver/prisma-deal-approver.repository.js";
import type { DealApproverRepository } from "./deal-approver/deal-approver.repository.js";
import { createDealApproverRouter } from "./routes/deal-approvers.js";
import { PrismaDealListRepository } from "./deal-list/prisma-deal-list.repository.js";
import { DealListService } from "./deal-list/deal-list.service.js";
import { PrismaSellerProfileRepository } from "./repositories/prisma-seller-profile.repository.js";
import type { DealListRepository } from "./deal-list/deal-list.repository.js";
import type { SellerProfileRepository } from "./repositories/seller-profile.repository.js";
import type { ProjectBriefRepository } from "./matchmaker/project-brief.repository.js";
import type { ProjectRequestRepository } from "./project-request/project-request.repository.js";
import type { MetadataRepository } from "./repositories/metadata.repository.js";
import type { AuthRepository } from "./auth-repository/auth-repository.js";
import type { DealTermsRepository } from "./deal-terms/deal-terms.repository.js";
import type { AudioRepository } from "./audio-repository/audio-repository.js";
import type { IdentityAdapter } from "./identity/identity-adapter.js";
import type { AiAdapter } from "./matchmaker/ai-adapter.js";
import type { StorageAdapter } from "./storage/storage-adapter.js";
import { buildStorageAdapters, type BuiltStorageAdapters } from "./storage/storage-factory.js";
import {
  buildIdentityAdapters,
  buildIdentityAdaptersAsync,
  type BuiltIdentityAdapters,
} from "./identity/identity-adapter-factory.js";
import {
  buildAiAdapters,
  readImpalaConfigFromEnv,
  type BuiltAiAdapters,
} from "./matchmaker/ai-adapter-factory.js";
import type { SmokeResult } from "./identity/managed-identity-adapter.js";
import { buildSafeError, generateRequestId, writeSafeError } from "./lib/errors.js";
import { getRequestId, storeRequestId } from "./lib/request-id.js";

export interface AppOptions {
  readonly service?: TalentSearchService;
  readonly metadataRepository?: MetadataRepository;
  readonly prismaClient?: PrismaClient;
  readonly authenticationService?: AuthenticationService;
  readonly workspaceAuthorizationService?: WorkspaceAuthorizationService;
  readonly authRepository?: AuthRepository;
  readonly identityAdapter?: IdentityAdapter;
  /**
   * Pre-built identity adapter bundle. Compose-time callers (the
   * async app builder below) construct the bundle once via the
   * factory and pass it here so the same managed adapter instance
   * the smoke probed is also the instance serving the request.
   * Per ticket #59 P1-002 the served adapter MUST be the same
   * instance the smoke validated — building a second adapter
   * would let the callback URL drift out of sync with the
   * smoke's validated configuration.
   */
  readonly identityAdapters?: BuiltIdentityAdapters;
  /**
   * Pre-computed bounded smoke result. Tests inject an explicit
   * success/failure to exercise the factory decision without a
   * real network round-trip. Production callers should leave this
   * unset and use {@link buildAppWithSmoke} so the factory runs
   * the smoke on its own managed adapter (per ticket #59 P1-001).
   */
  readonly managedSmoke?: SmokeResult;
  /**
   * Explicit override for the identity adapter selection. When
   * supplied, the factory bypasses the smoke-driven selection
   * entirely. The smoke is still skipped in this mode so test
   * harnesses can stay network-free.
   */
  readonly identityAdapterOverride?: "managed-magic-link" | "deterministic";
  /**
   * Pre-built AI adapter bundle. The Matchmaker service uses the
   * active adapter as its primary path; the deterministic fallback
   * is always wired in. Tests can inject their own bundle to
   * exercise the managed path.
   */
  readonly aiAdapters?: BuiltAiAdapters;
  readonly projectBriefRepository?: ProjectBriefRepository;
  readonly matchmakerService?: MatchmakerService;
  readonly aiAdapter?: AiAdapter;
  /**
   * Override for the audio repository. When supplied, the composition
   * root does NOT construct the Prisma adapter; the override is
   * served directly. Tests pass the in-memory adapter.
   */
  readonly audioRepository?: AudioRepository;
  /**
   * Pre-built storage adapter bundle. When supplied, the composition
   * root uses the same instance the served factory built so tests
   * can assert object identity. The factory's default selection is
   * driven by `BG2_STORAGE_BACKEND` and the Supabase configuration.
   */
  readonly storageAdapters?: BuiltStorageAdapters;
  /**
   * Override for the active storage adapter. When supplied, the
   * composition root uses this adapter instead of the bundle's
   * `active`. Tests inject a deterministic adapter.
   */
  readonly storageAdapterOverride?: StorageAdapter;
  /**
   * Override for the audio sample service. When supplied, the
   * composition root uses this service instead of constructing one
   * from the repository and storage adapter.
   */
  readonly audioSampleService?: AudioSampleService;
  readonly projectRequestRepository?: ProjectRequestRepository;
  readonly projectRequestService?: ProjectRequestService;
  /**
   * Override for the DealTerms repository. When supplied, the
   * composition root does NOT construct the Prisma adapter; the
   * override is served directly. Tests pass the in-memory adapter.
   */
  readonly dealTermsRepository?: DealTermsRepository;
  /**
   * Override for the DealTerms service. When supplied, the
   * composition root uses this service instead of constructing one
   * from the repository.
   */
  readonly dealTermsService?: DealTermsService;
  /**
   * M2 (#88): override for the DealApprover repository. When
   * supplied, the composition root does NOT construct the Prisma
   * adapter; the override is served directly. Tests pass the
   * in-memory adapter.
   */
  readonly dealApproverRepository?: DealApproverRepository;
  /**
   * M2 (#88): override for the DealApprover service. When supplied,
   * the composition root uses this service instead of constructing
   * one from the repository.
   */
  readonly dealApproverService?: DealApproverService;
  /**
   * Override for the Deal-discovery list repository (ticket #74).
   * When supplied, the composition root does NOT construct the Prisma
   * adapter. Tests pass the in-memory adapter, which runs the same
   * authorization policy.
   */
  readonly dealListRepository?: DealListRepository;
  /**
   * Override for the Deal-discovery list service. When supplied, the
   * composition root uses this service instead of constructing one
   * from the repository.
   */
  readonly dealListService?: DealListService;
  /**
   * Override for the SellerProfile service (ticket #84). When
   * supplied, the composition root does NOT construct the service
   * from the repository and authorization service; the override is
   * served directly. Tests inject an in-memory-backed service.
   */
  readonly sellerProfileService?: SellerProfileService;
  /**
   * Override for the SellerProfile repository (ticket #84). When
   * supplied, the composition root does NOT construct the Prisma
   * adapter; the override is served directly. Tests inject the
   * in-memory adapter.
   */
  readonly sellerProfileRepository?: SellerProfileRepository;
  /**
   * M2 (#85): override for the ServiceOffering service. Tests inject
   * a stub service backed by the in-memory repository.
   */
  readonly serviceOfferingService?: ServiceOfferingService;
  /**
   * M2 (#85): override for the ServiceOffering repository. Tests
   * inject the in-memory adapter.
   */
  readonly serviceOfferingRepository?: ServiceOfferingRepository;
  /**
   * Override for the Personal Workspace convergence service
   * (ticket #82). When supplied, the composition root does NOT
   * construct the service from the auth repository; the override
   * is served directly. Tests inject an in-memory-backed service
   * (or the service with a stub repository).
   */
  readonly personalWorkspaceConvergenceService?: PersonalWorkspaceConvergenceService;
  /**
   * Override for the Intent selection service (ticket #83). When
   * supplied, the composition root does NOT construct the service
   * from the auth repository and authorization service; the
   * override is served directly. Tests inject a stub service.
   */
  readonly intentService?: IntentService;
}

export interface BuiltApp {
  readonly app: Application;
  readonly prisma: PrismaClient;
  readonly service: TalentSearchService;
  readonly authenticationService: AuthenticationService;
  readonly workspaceAuthorizationService: WorkspaceAuthorizationService;
  readonly authRepository: AuthRepository;
  readonly identityAdapter: IdentityAdapter;
  readonly matchmakerService: MatchmakerService;
  readonly aiAdapter: AiAdapter;
  readonly audioSampleService: AudioSampleService;
  readonly storageAdapter: StorageAdapter;
  readonly storageBackend: "supabase" | "deterministic";
  readonly projectRequestService: ProjectRequestService;
  readonly dealTermsService: DealTermsService;
  readonly dealListService: DealListService;
  /**
   * M2 (#82): Personal Workspace convergence service. Composed at
   * the composition root and injected into `AuthenticationService`.
   */
  readonly personalWorkspaceConvergenceService: PersonalWorkspaceConvergenceService;
  /**
   * M2 (#83): Intent selection service. Composed at the composition
   * root from the auth repository and authorization service; injected
   * into `createIntentRouter`.
   */
  readonly intentService: IntentService;
  /**
   * M2 (#84): SellerProfile service. Composed at the composition
   * root from the SellerProfile repository and the workspace
   * authorization service; injected into `createSellerProfileRouter`.
   */
  readonly sellerProfileService: SellerProfileService;
  readonly sellerProfileRepository: SellerProfileRepository;
  /**
   * M2 (#85): ServiceOffering service composed at the composition
   * root from the ServiceOffering repository and the workspace
   * authorization service.
   */
  readonly serviceOfferingService: ServiceOfferingService;
  readonly serviceOfferingRepository: ServiceOfferingRepository;
}

export function buildApp(options: AppOptions = {}): BuiltApp {
  const prisma = options.prismaClient ?? createPrismaClient();
  const service =
    options.service ?? new TalentSearchService(new PrismaTalentSearchRepository(prisma));
  const metadataRepository = options.metadataRepository ?? new PrismaMetadataRepository(prisma);

  const authRepository = options.authRepository ?? new PrismaAuthRepository(prisma);
  // Per ticket #59 P1-002: when the caller has already built the
  // identity adapter bundle (the deployed entry point does this via
  // `buildAppWithSmoke`), inject the SAME bundle here so the
  // serving routes use the EXACT adapter instance the smoke
  // validated. Falling back to a fresh bundle only happens for
  // test code that wants the factory to construct its own
  // adapters; the served adapter in that path is still driven by
  // the supplied `managedSmoke` so tests cannot drift.
  const identityAdapters =
    options.identityAdapters ??
    buildIdentityAdapters({
      override: options.identityAdapterOverride,
      supabase: {
        url: process.env.SUPABASE_URL,
        anonKey: process.env.SUPABASE_ANON_KEY,
        serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      },
      emailRedirectTo: process.env.AUTH_CALLBACK_URL,
      log: (message) => {
        console.log(`[bg1] ${message}`);
      },
      managedSmoke: options.managedSmoke,
    });
  const identityAdapter = options.identityAdapter ?? identityAdapters.active;
  // M2 (#82): Personal Workspace convergence service. Wired into
  // the AuthenticationService so first-auth converges atomically and
  // recovery is surfaced via `setupState`.
  const personalWorkspaceConvergenceService =
    options.personalWorkspaceConvergenceService ??
    new PersonalWorkspaceConvergenceService({ authRepository });
  const authenticationService =
    options.authenticationService ??
    new AuthenticationService({
      identityAdapter,
      authRepository,
      personalWorkspaceConvergenceService,
    });
  const workspaceAuthorizationService =
    options.workspaceAuthorizationService ?? new WorkspaceAuthorizationService({ authRepository });

  // M2 (#83): Intent selection service. Wired from the auth
  // repository and authorization service. Tests can inject a stub
  // via `options.intentService` to bypass real repository work.
  const intentService =
    options.intentService ??
    new IntentService({
      authRepository,
      workspaceAuthorizationService,
    });

  // BG3 Matchmaker: build the AI adapter bundle (managed stub OR
  // deterministic fallback) and the project-brief repository, then
  // wire the MatchmakerService. The deterministic fallback is the
  // approved buildathon path; a future managed adapter slots in via
  // the factory without changing the service contract.
  //
  // The factory reads IMPALA_BASE_URL / IMPALA_API_KEY / IMPALA_MODEL
  // from the process env at composition time. The API key is held
  // inside the adapter instance and is never logged, returned by
  // the factory, or surfaced through any DTO.
  const aiAdapters =
    options.aiAdapters ??
    buildAiAdapters({
      managedConfig: readImpalaConfigFromEnv() ?? undefined,
      log: (message) => {
        console.log(`[matchmaker] ${message}`);
      },
    });
  const aiAdapter = options.aiAdapter ?? aiAdapters.active;
  const projectBriefRepository =
    options.projectBriefRepository ?? new PrismaProjectBriefRepository(prisma);
  const matchmakerService =
    options.matchmakerService ??
    new MatchmakerService({
      talentSearchService: service,
      workspaceAuthorizationService,
      projectBriefRepository,
      aiAdapter,
      fallbackAiAdapter: aiAdapters.deterministic,
    });

  // BG2: storage adapter bundle. The factory owns the
  // Supabase-vs-deterministic selection so the same env-var set
  // drives the identity adapter and the storage backend.
  const storageBundle =
    options.storageAdapters ??
    buildStorageAdapters({
      supabaseUrl: process.env.SUPABASE_URL,
      supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      bucket: process.env.SUPABASE_STORAGE_BUCKET,
      signedUrlExpiresInSeconds: process.env.SUPABASE_STORAGE_SIGNED_URL_TTL_SECONDS
        ? Number(process.env.SUPABASE_STORAGE_SIGNED_URL_TTL_SECONDS)
        : undefined,
      playbackBaseUrl: process.env.PUBLIC_API_BASE_URL ?? "http://localhost:4000",
    });
  const storageAdapter: StorageAdapter = options.storageAdapterOverride ?? storageBundle.active;

  const audioRepository = options.audioRepository ?? new PrismaAudioRepository(prisma);
  const audioSampleService =
    options.audioSampleService ??
    new AudioSampleService({
      repository: audioRepository,
      storage: storageAdapter,
      workspaceAuthorization: workspaceAuthorizationService,
      // The in-app playback route resolves relative to the API
      // origin. The browser fetches this URL for `<audio src=>`; the
      // route proxy-streams the bytes from the storage adapter.
      publicApiBaseUrl: process.env.PUBLIC_API_BASE_URL ?? "http://localhost:4000",
    });

  // BG4 ProjectRequest service. The composition root owns the
  // Prisma adapter; the service is the only boundary the route
  // and tests depend on.
  const projectRequestRepository =
    options.projectRequestRepository ?? new PrismaProjectRequestRepository(prisma);
  // M2 (#88) Codex finding (post 8d1ac3b): the GET
  // ProjectRequest command surfaces the allow-listed
  // ProjectBrief content. The composition root owns the
  // Prisma brief adapter; the ProjectRequest service is the
  // only boundary the route and tests depend on.
  const projectRequestService =
    options.projectRequestService ??
    new ProjectRequestService({
      projectRequestRepository,
      workspaceAuthorizationService,
      projectBriefRepository,
    });

  // M2 (#88): DealApprover JIT permission setup service. The
  // composition root owns the Prisma adapter; the service is the
  // only boundary the route and tests depend on. Provisioning is
  // capability-neutral, Personal-Workspace-scoped, and never
  // creates a `DealApproval` (the approval command remains BG5's
  // `recordApprovalInTransaction`). The DealTermsService also
  // reads from this repository to derive the
  // `actingSideHasDealApprover` signal on the Deal view, so
  // it must be constructed BEFORE the DealTermsService.
  const dealApproverRepository =
    options.dealApproverRepository ?? new PrismaDealApproverRepository(prisma);

  // BG5 DealTerms service. The composition root owns the Prisma
  // adapter; the service is the only boundary the route and tests
  // depend on. The deterministic AI adapter is the buildathon-only
  // AI path; no managed provider integration is wired.
  const dealTermsRepository = options.dealTermsRepository ?? new PrismaDealTermsRepository(prisma);
  const dealTermsService =
    options.dealTermsService ??
    new DealTermsService({
      dealTermsRepository,
      workspaceAuthorizationService,
      projectRequestRepository,
      // M2 (#88) Codex finding: the Deal view needs the
      // durable `(workspaceId, userId)` `deal_approvers` row
      // so the web can render the permission CTA and the
      // approve CTA MUTUALLY EXCLUSIVELY. The lookup is
      // fail-closed when the repository is omitted.
      dealApproverRepository,
    });
  const dealApproverService =
    options.dealApproverService ??
    new DealApproverService({
      dealApproverRepository,
    });

  // BG6 PaymentIntent + activation service. The composition root
  // owns the Prisma adapter and the deterministic mock escrow
  // provider; no managed provider integration is wired. Tests can
  // inject a custom repository or escrow provider via options.
  const fundingRepository = new PrismaFundingRepository(prisma);
  const escrowProvider = new DeterministicMockEscrowProvider();
  const fundingService = new FundingService({
    fundingRepository,
    escrowProvider,
  });

  // Deals discovery list (ticket #74). The list authorizes and reads
  // in ONE transaction: the repository FOR UPDATE-locks the exact
  // Workspace + membership rows, the service-owned policy decides,
  // and Deals are read only on an accept. A membership revoked
  // concurrently therefore cannot leak private rows.
  const dealListRepository = options.dealListRepository ?? new PrismaDealListRepository(prisma);
  const dealListService =
    options.dealListService ?? new DealListService({ repository: dealListRepository });

  // M2 (#84): SellerProfile service. Composed from the
  // SellerProfile repository (Prisma adapter by default; tests
  // inject the in-memory adapter) and the workspace authorization
  // service. The SellerProfile repository is the only place that
  // reads or writes `seller_profiles`, `seller_profile_specialties`,
  // `caribbean_affiliations`, and `seller_profile_publications`.
  const sellerProfileRepository =
    options.sellerProfileRepository ?? new PrismaSellerProfileRepository(prisma);
  const sellerProfileService =
    options.sellerProfileService ??
    new SellerProfileService({
      repository: sellerProfileRepository,
      workspaceAuthorizationService,
    });

  // M2 (#85): ServiceOffering service. Composed from the
  // ServiceOffering repository (Prisma adapter by default; tests
  // inject the in-memory adapter) and the workspace authorization
  // service. The ServiceOffering repository is the only place that
  // reads or writes `service_offerings`,
  // `service_offering_service_areas`, `offering_pricing`,
  // `included_services`, and `service_offering_activations` for
  // the seller-offering slice.
  const sellerProfileStatusReader = async (input: { readonly workspaceId: string }) => {
    const row = await prisma.sellerProfile.findUnique({
      where: { workspaceId: input.workspaceId },
      select: { status: true },
    });
    return row?.status ?? null;
  };
  const playbackBaseUrl = process.env.PUBLIC_API_BASE_URL ?? "http://localhost:4000";
  const playbackUrlFor = (input: { offeringId: string; sampleId: string }) =>
    `${playbackBaseUrl.replace(/\/+$/, "")}/api/services/${encodeURIComponent(input.offeringId)}/audio-samples/${encodeURIComponent(input.sampleId)}/play`;
  const serviceOfferingRepository =
    options.serviceOfferingRepository ?? new PrismaServiceOfferingRepository(prisma);
  const serviceOfferingService =
    options.serviceOfferingService ??
    new ServiceOfferingService({
      repository: serviceOfferingRepository,
      workspaceAuthorizationService,
      getSellerProfileStatus: sellerProfileStatusReader,
      playbackUrlFor,
    });

  const app: Application = express();
  app.disable("x-powered-by");
  app.use(helmet());
  app.use(
    cors({
      origin: process.env.FRONTEND_URL ?? "http://localhost:3000",
      credentials: true,
    }),
  );

  // Global request-id sanitizer (M2 #83 CodeQL hardening).
  //
  // The untrusted `x-request-id` header is sanitized at the
  // application boundary via `lib/request-id`. The resulting
  // value is the ONLY one consumed by every downstream sink:
  //   - the per-route handlers, which read it back via the
  //     canonical accessor `getRequestId(req)` (NOT a fresh
  //     re-sanitization of the raw header — that would
  //     generate a second UUID for invalid inputs and break
  //     the end-to-end correlation invariant);
  //   - the 404 fallback below;
  //   - the error middleware below, whose `console.error` used
  //     to interpolate `${requestId}` into the format string
  //     and was the second reachable format-string sink flagged
  //     by CodeQL after the route-local sink in
  //     `apps/api/src/routes/intent.ts` was fixed.
  //
  // Storing the sanitized value on the request and reading it
  // back in the error middlewares eliminates the gap between
  // the route-local sink and the global sink.
  app.use((req, res, next) => {
    const requestId = storeRequestId(req as Request & { requestId?: string });
    res.setHeader("x-request-id", requestId);
    next();
  });

  app.use("/api/health", healthRoutes);
  app.use("/api/search", createSearchRouter({ service }));
  app.use("/api/metadata", createMetadataRouter({ repository: metadataRepository }));
  const catalogRepository = new PrismaOfferingCatalogRepository(prisma);
  app.use("/api/metadata", createOfferingCatalogRouter({ catalogRepository }));
  app.use(
    "/api/auth",
    createAuthRouter({
      authenticationService,
      workspaceAuthorizationService,
      authRepository,
      allowedReturnOrigin: process.env.FRONTEND_URL ?? "http://localhost:3000",
    }),
  );
  app.use(
    "/api/matchmaker",
    createMatchmakerRouter({
      authenticationService,
      matchmakerService,
    }),
  );
  app.use(
    "/api",
    createAudioSamplesRouter({
      service: audioSampleService,
      authenticationService,
    }),
  );
  app.use(
    "/api/project-requests",
    createProjectRequestRouter({
      authenticationService,
      projectRequestService,
    }),
  );
  // M2 (#88): Personal-Workspace DealApprover JIT permission setup
  // surface. The router wires the single `POST /api/deal-approvers`
  // endpoint; the safe envelope collapses every authorization
  // rejection to `DEAL_APPROVER_FORBIDDEN` (403) and never exposes
  // private audit identifiers.
  app.use(
    "/api/deal-approvers",
    createDealApproverRouter({
      authenticationService,
      dealApproverService,
      generateRequestId,
    }),
  );
  // Ticket #74: the Deals collection route is registered BEFORE the
  // per-Deal routers so the collection path stays unambiguously ahead
  // of their "/:dealId" dispatchers.
  app.use(
    "/api/deals",
    createDealListRouter({
      authenticationService,
      dealListService,
    }),
  );
  // M2 (#83): Intent selection route. Mounted at `/api/workspaces`
  // so the URL path `/:workspaceId/intent` reads the acting
  // Workspace id directly. The route revalidates current
  // membership via `WorkspaceAuthorizationService.requireActingMembership`
  // (membership-not-Owner-only per ticket #82).
  app.use(
    "/api/workspaces",
    createIntentRouter({
      authenticationService,
      intentService,
      personalWorkspaceConvergenceService,
      allowedReturnOrigin: process.env.FRONTEND_URL ?? "http://localhost:3000",
    }),
  );
  // M2 (#84): SellerProfile route family. Mounted at
  // `/api/workspaces` so the URL path
  // `/:workspaceId/seller-profile/...` reads the acting Workspace
  // id directly. The service revalidates current membership +
  // Seller capability + Personal-Workspace identity via
  // `WorkspaceAuthorizationService`.
  app.use(
    "/api/workspaces",
    createSellerProfileRouter({
      service: sellerProfileService,
      authenticationService,
      allowedReturnOrigin: process.env.FRONTEND_URL ?? "http://localhost:3000",
    }),
  );
  // M2 (#85): ServiceOffering route family. Mounted at
  // `/api/workspaces` so the URL path
  // `/:workspaceId/service-offerings/...` reads the acting Workspace
  // id directly. The service revalidates current membership +
  // Seller capability + Personal-Workspace identity via
  // `WorkspaceAuthorizationService`.
  app.use(
    "/api/workspaces",
    createServiceOfferingRouter({
      service: serviceOfferingService,
      authenticationService,
      // M2 (#85) PR-review feedback: the authenticated owner-side
      // audio surface (owner list + owner play) hangs off the
      // service-offering router, so the same workspace-scoped
      // authorization chain guards the audio routes. The public
      // buyer-side audio surface lives on the standalone audio
      // router at /api/services/... (unchanged).
      audioSampleService,
      allowedReturnOrigin: process.env.FRONTEND_URL ?? "http://localhost:3000",
    }),
  );
  app.use(
    "/api/deals",
    createDealTermsRouter({
      authenticationService,
      dealTermsService,
    }),
  );
  app.use(
    "/api/deals",
    createBg6FundingRouter({
      authenticationService,
      fundingService,
      dealTermsService,
    }),
  );

  // 404 fallback
  app.use((req: Request, res: Response) => {
    // Read the boundary-stored correlation id (or resolve a
    // fresh sanitized UUID if the boundary never ran). Using
    // the same accessor as the route handlers guarantees the
    // response header, the safe-error envelope, and any log
    // line all carry the same correlation id.
    const requestId = getRequestId(req as Request & { requestId?: string });
    const safe = buildSafeError(
      "INVALID_SEARCH_CRITERIA",
      "Route not found.",
      undefined,
      requestId,
    );
    writeSafeError(res, safe);
  });

  // Error middleware
  app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    void _next;
    // Read the boundary-stored correlation id (or resolve a
    // fresh sanitized UUID if the boundary never ran). The same
    // accessor is consumed by every other sink so the response
    // header, the safe-error envelope, and this log line all
    // carry the same correlation id.
    const requestId = getRequestId(req as Request & { requestId?: string });
    // The format string MUST be a literal constant — Node's
    // `console.error` passes its first argument through
    // `util.format`, which interprets `%s`, `%d`, `%o`, `%j`,
    // etc. as format specifiers. Earlier passes interpolated
    // `requestId` directly into the template literal; once an
    // untrusted `x-request-id` reaches here, an attacker-
    // supplied `%s` would steer util.format substitution. The
    // value is also pre-sanitized by the boundary middleware
    // (M2 #83 CodeQL hardening) as defense-in-depth.
    console.error("[talent-search] requestId=%s unhandled:", requestId, err);
    const safe = buildSafeError(
      "SEARCH_FAILED",
      "An unexpected error occurred while processing the request.",
      undefined,
      requestId,
    );
    writeSafeError(res, safe);
  });

  return {
    app,
    prisma,
    service,
    authenticationService,
    workspaceAuthorizationService,
    authRepository,
    identityAdapter,
    matchmakerService,
    aiAdapter,
    audioSampleService,
    storageAdapter,
    storageBackend: storageBundle.backend,
    projectRequestService,
    dealTermsService,
    dealListService,
    personalWorkspaceConvergenceService,
    intentService,
    sellerProfileService,
    sellerProfileRepository,
    serviceOfferingService,
    serviceOfferingRepository,
  };
}

/**
 * Run the bounded deployed-provider configuration smoke AND assemble
 * the app, using the same managed adapter the smoke probed. The
 * factory owns the smoke so production startup never silently
 * picks the deterministic fallback, and the smoke can never drift
 * out of sync with the serving adapter — the served adapter is the
 * SAME instance the smoke validated.
 *
 * Per ticket #59 the configuration smoke is a bounded,
 * non-destructive probe of the managed provider's `/auth/v1/health`
 * endpoint. It does NOT request, consume, or revoke a live
 * Supabase OTP. End-to-end managed email verification is validated
 * by an explicit bounded operational smoke procedure (see
 * `docs/deployment/managed-provider-smoke.md`), not by
 * application startup.
 *
 * Test code continues to call {@link buildApp} directly with
 * mocked services so the unit suite remains network-free.
 */
export async function buildAppWithSmoke(
  options: Omit<AppOptions, "managedSmoke" | "identityAdapterOverride" | "identityAdapters"> = {},
): Promise<BuiltApp> {
  const prisma = options.prismaClient ?? createPrismaClient();
  const authRepository = options.authRepository ?? new PrismaAuthRepository(prisma);
  // Build the managed adapter ONCE so the configuration smoke and
  // the serving routes share the SAME instance. The factory's
  // `emailRedirectTo` defaults to AUTH_CALLBACK_URL so the
  // callback URL the smoke validates is the exact value serving
  // uses.
  const { ManagedIdentityAdapter } = await import("./identity/managed-identity-adapter.js");
  const managed = new ManagedIdentityAdapter({
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
    supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    emailRedirectTo: process.env.AUTH_CALLBACK_URL,
  });
  // Run the bounded configuration smoke ONCE through the factory
  // using the SAME managed adapter instance the composition root
  // will serve. The factory returns the bundle whose `active`
  // adapter is either the managed adapter (smoke passed) or the
  // deterministic adapter (smoke failed) — and the bundle exposes
  // the managed instance so tests can assert object identity with
  // the serving adapter.
  const bundle = await buildIdentityAdaptersAsync({
    managed,
    log: (message) => {
      console.log(`[bg1] ${message}`);
    },
  });
  // Per review nitpick: forward the Prisma client we created (and
  // bound `authRepository` to) into `buildApp`. Without this,
  // `buildApp` would call `options.prismaClient ?? createPrismaClient()`
  // and create a SECOND, unrelated client — the served repository
  // graph would split across two pools and only one of them would
  // ever be disconnected on shutdown.
  //
  // BG2: build the storage adapter bundle using the same Supabase
  // configuration the BG1 smoke probed, so the served routes use
  // the configured Supabase bucket (or the deterministic fallback)
  // without a second selection round.
  const storageBundle =
    options.storageAdapters ??
    buildStorageAdapters({
      supabaseUrl: process.env.SUPABASE_URL,
      supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      bucket: process.env.SUPABASE_STORAGE_BUCKET,
      signedUrlExpiresInSeconds: process.env.SUPABASE_STORAGE_SIGNED_URL_TTL_SECONDS
        ? Number(process.env.SUPABASE_STORAGE_SIGNED_URL_TTL_SECONDS)
        : undefined,
      playbackBaseUrl: process.env.PUBLIC_API_BASE_URL ?? "http://localhost:4000",
    });
  return buildApp({
    ...options,
    prismaClient: prisma,
    identityAdapters: bundle,
    authRepository,
    storageAdapters: storageBundle,
  });
}
