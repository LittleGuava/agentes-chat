import { afterEach, describe, expect, test } from "bun:test";
import { createMemoryRateLimiter } from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import {
  addJoinDomain,
  askToJoin,
  domainWorkspaces,
  ForbiddenError,
  inviteLink,
  joinByDomain,
  listJoinDomains,
  memberRoleIds,
  normalizeJoinDomain,
  type OrgLimits,
  removeJoinDomain,
  removeMember,
  setOrgLimits,
} from "../src";
import { addMember, adminRoleId, type Fixture, SECRET, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const NONE: OrgLimits = {
  members: null,
  membersMax: null,
  payerUserId: null,
  storageBytes: null,
  uploadBytesPerDay: null,
  platformUsdPerMonth: null,
};
const deps = () => ({ db: f.db, pubsub: f.pubsub });

/** The owner's own address is a confirmed one at `acme.test`, as an admin adding that domain needs. */
async function start() {
  f = await setup();
  await f.db
    .update(schema.users)
    .set({ email: "ana@acme.test", emailVerified: true })
    .where(eq(schema.users.id, f.owner.id));
}

/** A person with an account at this address (`verified`: they opened the confirmation link). */
async function person(email: string, verified = true) {
  const id = `user_${email.replace(/\W/g, "_")}`;
  await f.db.insert(schema.users).values({ id, name: email.split("@")[0] ?? "x", email, emailVerified: verified });
  return { id, email };
}

const memberOf = async (userId: string) =>
  (
    await f.db
      .select()
      .from(schema.organizationMembers)
      .where(and(eq(schema.organizationMembers.orgId, f.org.id), eq(schema.organizationMembers.userId, userId)))
  )[0];
const audits = (action: string) =>
  f.db
    .select()
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.orgId, f.org.id), eq(schema.auditLog.action, action)));

describe("domains an admin names", () => {
  test("are normalized, refused when public, not a host, or not the admin's own; only admins add them", async () => {
    await start();
    const added = await addJoinDomain(f.db, f.owner.id, f.org.id, { domain: "  @ACME.test " });
    expect(added).toMatchObject({ domain: "acme.test", roleIds: [] });
    expect((await listJoinDomains(f.db, f.owner.id, f.org.id)).map((d) => d.domain)).toEqual(["acme.test"]);
    expect(await audits("join_domain.added")).toHaveLength(1);

    await expect(addJoinDomain(f.db, f.owner.id, f.org.id, { domain: "gmail.com" })).rejects.toMatchObject({
      code: "join_domain.public",
    });
    await expect(addJoinDomain(f.db, f.owner.id, f.org.id, { domain: "not a domain" })).rejects.toMatchObject({
      code: "join_domain.invalid",
    });
    // A provider's national domains are public too; a company's subdomain that starts like one isn't.
    for (const domain of ["outlook.de", "hotmail.it", "yahoo.es", "gmx.at", "hotmail.co.uk", "live.com.br"]) {
      expect(() => normalizeJoinDomain(domain)).toThrow(expect.objectContaining({ code: "join_domain.public" }));
    }
    expect(normalizeJoinDomain("live.acme.test")).toBe("live.acme.test");
    // The admin's address is at acme.test, not at this one: any workspace could otherwise show itself to that company.
    await expect(addJoinDomain(f.db, f.owner.id, f.org.id, { domain: "other.test" })).rejects.toMatchObject({
      code: "join_domain.not_yours",
    });
    // A subdomain is a domain of its own.
    await expect(addJoinDomain(f.db, f.owner.id, f.org.id, { domain: "eu.acme.test" })).rejects.toMatchObject({
      code: "join_domain.not_yours",
    });

    const member = await addMember(f.db, f.org.id, "member", "bia");
    await expect(listJoinDomains(f.db, member.id, f.org.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(addJoinDomain(f.db, member.id, f.org.id, { domain: "acme.test" })).rejects.toBeInstanceOf(
      ForbiddenError,
    );

    await removeJoinDomain(f.db, f.owner.id, f.org.id, added.id);
    expect(await listJoinDomains(f.db, f.owner.id, f.org.id)).toEqual([]);
    expect(await audits("join_domain.removed")).toHaveLength(1);
  });
});

describe("joining by domain", () => {
  test("a confirmed account at the domain sees the workspace and joins, with the domain's cargos, audited", async () => {
    await start();
    const admin = await adminRoleId(f.db, f.org.id);
    await addJoinDomain(f.db, f.owner.id, f.org.id, { domain: "acme.test", roleIds: [admin] });
    const caio = await person("caio@acme.test");

    expect(await domainWorkspaces(f.db, caio.id)).toEqual([{ id: f.org.id, name: f.org.name, logo: null }]);
    expect(await joinByDomain(deps(), caio.id, f.org.id)).toEqual({ orgId: f.org.id });
    expect(await memberOf(caio.id)).toMatchObject({ role: "member" });
    expect(await memberRoleIds(f.db, f.org.id, caio.id)).toEqual([admin]);
    const [joined] = await audits("member.joined");
    expect(joined?.details).toMatchObject({ via: "domain", domain: "acme.test", roleIds: [admin] });
    // In now: nothing left to join.
    expect(await domainWorkspaces(f.db, caio.id)).toEqual([]);
  });

  test("an account whose address isn't confirmed neither sees nor joins", async () => {
    await start();
    await addJoinDomain(f.db, f.owner.id, f.org.id, { domain: "acme.test" });
    const dani = await person("dani@acme.test", false);
    expect(await domainWorkspaces(f.db, dani.id)).toEqual([]);
    await expect(joinByDomain(deps(), dani.id, f.org.id)).rejects.toMatchObject({ code: "join_domain.not_allowed" });
    expect(await memberOf(dani.id)).toBeUndefined();
  });

  test("an address at another domain neither sees nor joins, nor once the domain is removed", async () => {
    await start();
    const added = await addJoinDomain(f.db, f.owner.id, f.org.id, { domain: "acme.test" });
    const edu = await person("edu@other.test");
    expect(await domainWorkspaces(f.db, edu.id)).toEqual([]);
    await expect(joinByDomain(deps(), edu.id, f.org.id)).rejects.toMatchObject({ code: "join_domain.not_allowed" });
    // A subdomain's address isn't the domain's.
    const sub = await person("sub@eu.acme.test");
    await expect(joinByDomain(deps(), sub.id, f.org.id)).rejects.toMatchObject({ code: "join_domain.not_allowed" });

    await removeJoinDomain(f.db, f.owner.id, f.org.id, added.id);
    const fabi = await person("fabi@acme.test");
    expect(await domainWorkspaces(f.db, fabi.id)).toEqual([]);
    await expect(joinByDomain(deps(), fabi.id, f.org.id)).rejects.toMatchObject({ code: "join_domain.not_allowed" });
  });

  test("a full workspace refuses whoever joins by domain", async () => {
    await start();
    await addJoinDomain(f.db, f.owner.id, f.org.id, { domain: "acme.test" });
    await setOrgLimits(f.db, f.org.id, { ...NONE, members: 1 });
    const gil = await person("gil@acme.test");
    await expect(joinByDomain(deps(), gil.id, f.org.id)).rejects.toMatchObject({
      code: "org.members_full",
      params: { members: 1, limit: 1 },
    });
    expect(await memberOf(gil.id)).toBeUndefined();
  });

  test("someone an admin removed comes back by invitation, not by domain", async () => {
    await start();
    await addJoinDomain(f.db, f.owner.id, f.org.id, { domain: "acme.test" });
    const hugo = await person("hugo@acme.test");
    await joinByDomain(deps(), hugo.id, f.org.id);
    await removeMember(f.db, f.owner.id, f.org.id, hugo.id);
    expect(await domainWorkspaces(f.db, hugo.id)).toEqual([]);
    await expect(joinByDomain(deps(), hugo.id, f.org.id)).rejects.toMatchObject({ code: "join_domain.not_allowed" });
  });

  test("a request they had waiting closes, and the admins' notice with it", async () => {
    await start();
    await addJoinDomain(f.db, f.owner.id, f.org.id, { domain: "acme.test" });
    const { token } = await inviteLink(f.db, SECRET, f.owner.id, f.org.id);
    const lia = await person("lia@acme.test");
    await askToJoin({ db: f.db, pubsub: f.pubsub, rateLimiter: createMemoryRateLimiter() }, "https://agentes.test/", {
      token,
      user: lia,
    });
    const notices = () => f.db.select().from(schema.notifications).where(eq(schema.notifications.kind, "join_request"));
    expect((await notices()).some((n) => n.doneAt === null)).toBe(true);
    await joinByDomain(deps(), lia.id, f.org.id);
    const [request] = await f.db.select().from(schema.organizationJoinRequests);
    expect(request?.status).toBe("closed");
    expect((await notices()).every((n) => n.doneAt !== null)).toBe(true);
  });

  test("naming a domain again changes its cargo; a workspace names at most 10", async () => {
    await start();
    const admin = await adminRoleId(f.db, f.org.id);
    const first = await addJoinDomain(f.db, f.owner.id, f.org.id, { domain: "acme.test" });
    const again = await addJoinDomain(f.db, f.owner.id, f.org.id, { domain: "acme.test", roleIds: [admin] });
    expect(again).toMatchObject({ id: first.id, roleIds: [admin] });
    expect(await listJoinDomains(f.db, f.owner.id, f.org.id)).toHaveLength(1);
    // Nine more, as if added by the admins of each (the rule on whose domain it is is the add's, tested above).
    await f.db
      .insert(schema.organizationJoinDomains)
      .values(Array.from({ length: 9 }, (_, i) => ({ orgId: f.org.id, domain: `d${i}.acme.test` })));
    await f.db.update(schema.users).set({ email: "ana@more.test" }).where(eq(schema.users.id, f.owner.id));
    await expect(addJoinDomain(f.db, f.owner.id, f.org.id, { domain: "more.test" })).rejects.toMatchObject({
      code: "join_domain.too_many",
      params: { max: 10 },
    });
  });

  test("the cargos are those whoever added the domain could still give", async () => {
    await start();
    const admin = await adminRoleId(f.db, f.org.id);
    const ivo = await addMember(f.db, f.org.id, "admin", "ivo");
    await f.db
      .update(schema.users)
      .set({ email: "ivo@acme.test", emailVerified: true })
      .where(eq(schema.users.id, ivo.id));
    const custom = await f.db
      .insert(schema.orgRoles)
      .values({ orgId: f.org.id, name: "Suporte", kind: "custom", position: 99, permissions: [] })
      .returning({ id: schema.orgRoles.id });
    const support = custom[0]?.id ?? "";
    await addJoinDomain(f.db, ivo.id, f.org.id, { domain: "acme.test", roleIds: [support] });
    // Ivo loses Admin: what the domain hands out goes with it.
    await f.db
      .delete(schema.organizationMemberRoles)
      .where(and(eq(schema.organizationMemberRoles.userId, ivo.id), eq(schema.organizationMemberRoles.roleId, admin)));
    const jo = await person("jo@acme.test");
    await joinByDomain(deps(), jo.id, f.org.id);
    expect(await memberOf(jo.id)).toBeDefined();
    expect(await memberRoleIds(f.db, f.org.id, jo.id)).toEqual([]);
  });
});
