import { Router, Request, Response } from 'express';
import { SpaceRepository, SpaceCategory } from '../../storage/space-repo.js';

export function createSpacesRouter(spaceRepo: SpaceRepository): Router {
  const router = Router();

  // GET /api/spaces - List spaces
  router.get('/', (req: Request, res: Response) => {
    try {
      const status = typeof req.query.status === 'string' ? (req.query.status as any) : 'all';
      const category = typeof req.query.category === 'string' ? req.query.category : undefined;
      const search = typeof req.query.search === 'string' ? req.query.search : undefined;
      const limit = req.query.limit ? Number(req.query.limit) : 50;

      const spaces = spaceRepo.list({ status, category, search, limit });
      res.json({ ok: true, count: spaces.length, spaces });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // GET /api/spaces/:slug - Get single space details with content
  router.get('/:slug', (req: Request, res: Response) => {
    try {
      const slug = String(req.params['slug']);
      const space = spaceRepo.get(slug);
      if (!space) {
        res.status(404).json({ ok: false, error: `Space "${slug}" not found` });
        return;
      }
      const content = spaceRepo.getContent(space.slug);
      res.json({ ok: true, space, content });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // POST /api/spaces - Create or update space manually from Web UI
  router.post('/', (req: Request, res: Response) => {
    try {
      const { slug, title, description, category, htmlContent, status } = req.body;
      if (!slug || !title) {
        res.status(400).json({ ok: false, error: 'slug and title are required' });
        return;
      }
      const space = spaceRepo.upsert({
        slug,
        title,
        description,
        category: category as SpaceCategory,
        created_by: 'owner',
        trigger_type: 'manual',
        status: status || 'active',
        htmlContent
      });
      res.json({ ok: true, space, url: `/spaces/${space.slug}` });
    } catch (err: any) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  // POST /api/spaces/:slug/archive - Archive space
  router.post('/:slug/archive', (req: Request, res: Response) => {
    try {
      const slug = String(req.params['slug']);
      const space = spaceRepo.archive(slug);
      if (!space) {
        res.status(404).json({ ok: false, error: `Space "${slug}" not found` });
        return;
      }
      res.json({ ok: true, space });
    } catch (err: any) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  // DELETE /api/spaces/:slug - Delete space completely
  router.delete('/:slug', (req: Request, res: Response) => {
    try {
      const slug = String(req.params['slug']);
      const deleted = spaceRepo.delete(slug);
      if (!deleted) {
        res.status(404).json({ ok: false, error: `Space "${slug}" not found` });
        return;
      }
      res.json({ ok: true, deleted: true, slug });
    } catch (err: any) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  return router;
}
