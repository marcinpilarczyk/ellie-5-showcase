import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { linkedInJobId, linkedInRegionalHost, fetchLinkedInJob, extractLinkedInJob, fetchWebPage } from '../tools/web-tools.js';

// Same structure as LinkedIn's public jobs-guest fragment; made-up content
const GUEST_FRAGMENT = `
<section class="top-card-layout">
  <h2 class="top-card-layout__title font-sans topcard__title">Implementation Lead</h2>
  <a class="topcard__org-name-link topcard__flavor--black-link" href="#"> Example Co </a>
  <span class="topcard__flavor topcard__flavor--bullet"> Warsaw, Mazowieckie, Poland </span>
  <span class="posted-time-ago__text topcard__flavor--metadata"> 2 days ago </span>
</section>
<div class="description__text description__text--rich">
  <section class="show-more-less-html">
    <div class="show-more-less-html__markup show-more-less-html__markup--clamp-after-5">
      <p><strong>About the role</strong></p><p>Lead enterprise onboarding &amp; rollout.</p>
      <p><strong>Requirements</strong></p><ul><li>5+ years in implementation</li><li>Fluent Polish &#x26; English</li></ul>
    </div>
  </section>
</div>
<ul class="description__job-criteria-list">
  <li class="description__job-criteria-item">
    <h3 class="description__job-criteria-subheader"> Seniority level </h3>
    <span class="description__job-criteria-text description__job-criteria-text--criteria"> Mid-Senior level </span>
  </li>
  <li class="description__job-criteria-item">
    <h3 class="description__job-criteria-subheader"> Employment type </h3>
    <span class="description__job-criteria-text description__job-criteria-text--criteria"> Full-time </span>
  </li>
</ul>`;

describe('LinkedIn job links', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  it('finds the job id in every common link shape', () => {
    assert.equal(linkedInJobId('https://www.linkedin.com/jobs/view/4479093378/'), '4479093378');
    assert.equal(linkedInJobId('https://pl.linkedin.com/jobs/view/implementation-lead-at-example-co-4479093378?refId=x'), '4479093378');
    assert.equal(linkedInJobId('https://www.linkedin.com/jobs/collections/recommended/?currentJobId=4479093378'), '4479093378');
    assert.equal(linkedInJobId('https://www.linkedin.com/in/someone/'), null);
    assert.equal(linkedInJobId('https://example.com/jobs/view/4479093378'), null);
  });

  it('extracts title, company, criteria and the full description with line breaks', () => {
    const job = extractLinkedInJob(GUEST_FRAGMENT)!;
    assert.equal(job.title, 'Implementation Lead at Example Co');
    assert.match(job.text, /^Title: Implementation Lead\nCompany: Example Co\nLocation: Warsaw, Mazowieckie, Poland\nPosted: 2 days ago\n/);
    assert.match(job.text, /Seniority level: Mid-Senior level\nEmployment type: Full-time/);
    assert.match(job.text, /Description:\nAbout the role\nLead enterprise onboarding & rollout\.\nRequirements\n- 5\+ years in implementation\n- Fluent Polish & English/);
  });

  it('returns null for an unrecognised layout instead of guessing', () => {
    assert.equal(extractLinkedInJob('<html><body>Sign in to see this job</body></html>'), null);
  });

  it('web_read_page fetches the guest posting directly, without Jina', async () => {
    const requested: string[] = [];
    globalThis.fetch = (async (url: any) => {
      requested.push(String(url));
      return new Response(GUEST_FRAGMENT, { status: 200 });
    }) as typeof fetch;

    const page = await fetchWebPage('https://www.linkedin.com/jobs/view/4479093378/');
    assert.equal(page.status, 'SUCCESS');
    assert.match(page.content, /Requirements\n- 5\+ years/);
    assert.deepEqual(requested, ['https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/4479093378']);
  });

  it('reads the guest posting through Jina when the endpoint is rate-limited', async () => {
    const requested: string[] = [];
    globalThis.fetch = (async (url: any) => {
      requested.push(String(url));
      return String(url).startsWith('https://r.jina.ai/')
        ? new Response('**Implementation Lead**\n' + 'Lead onboarding. '.repeat(40), { status: 200 })
        : new Response('', { status: 429 });
    }) as typeof fetch;

    const page = await fetchWebPage('https://www.linkedin.com/jobs/view/4479093378/', 15000);
    assert.equal(page.status, 'SUCCESS');
    assert.match(page.content, /Lead onboarding/);
    assert.equal(requested[0], 'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/4479093378');
    assert.equal(requested[requested.length - 1], 'https://r.jina.ai/https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/4479093378');
  });

  it('tries the link\'s own regional host when www is refused, and retries once after a 429', async () => {
    const requested: string[] = [];
    globalThis.fetch = (async (url: any) => {
      requested.push(String(url));
      return String(url).startsWith('https://pl.linkedin.com/')
        ? new Response(GUEST_FRAGMENT, { status: 200 })
        : new Response('', { status: 429 });
    }) as typeof fetch;
    const own = await fetchLinkedInJob('4479093378', 15000, linkedInRegionalHost('https://pl.linkedin.com/jobs/view/x-4479093378'), 10);
    assert.equal(own?.title, 'Implementation Lead at Example Co');
    assert.deepEqual(requested.map(u => new URL(u).host), ['www.linkedin.com', 'pl.linkedin.com']);
    assert.equal(linkedInRegionalHost('https://www.linkedin.com/jobs/view/1'), null);

    requested.length = 0;
    let calls = 0;
    globalThis.fetch = (async (url: any) => {
      requested.push(String(url));
      return ++calls === 1 ? new Response('', { status: 429 }) : new Response(GUEST_FRAGMENT, { status: 200 });
    }) as typeof fetch;
    const retried = await fetchLinkedInJob('4479093378', 15000, null, 10);
    assert.equal(retried?.title, 'Implementation Lead at Example Co');
    assert.equal(requested.length, 2);
  });

  it('reports BLOCKED, not a generic read, when every LinkedIn route refuses', async () => {
    globalThis.fetch = (async () => new Response('', { status: 403 })) as typeof fetch;
    const page = await fetchWebPage('https://www.linkedin.com/jobs/view/4479093378/', 3000);
    assert.equal(page.status, 'BLOCKED');
  });
});
