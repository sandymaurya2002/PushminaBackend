import { Router } from 'express'
import { validateParams, validateQuery } from '../../middleware/validate'
import { searchLimiter } from '../../middleware/rate-limit'
import {
  collectionListQuerySchema,
  limitQuerySchema,
  productQuerySchema,
  searchQuerySchema,
  slugParamSchema,
  slugsQuerySchema,
} from './catalog.schema'
import * as controller from './catalog.controller'

export const catalogRouter = Router()

/* Taxonomy — filter vocabulary, all admin-managed ------------------ */
catalogRouter.get('/taxonomy', controller.getTaxonomy)
catalogRouter.get('/colors', controller.listColors)

/* Categories ------------------------------------------------------- */
catalogRouter.get('/categories', controller.listCategories)
catalogRouter.get('/categories/:slug', validateParams(slugParamSchema), controller.getCategory)

/* Collections ------------------------------------------------------ */
catalogRouter.get(
  '/collections',
  validateQuery(collectionListQuerySchema),
  controller.listCollections,
)
catalogRouter.get(
  '/collections/:slug',
  validateParams(slugParamSchema),
  controller.getCollection,
)
catalogRouter.get(
  '/collections/:slug/products',
  validateParams(slugParamSchema),
  validateQuery(productQuerySchema),
  controller.getCollectionProducts,
)

/* Merchandised rails ----------------------------------------------- */
catalogRouter.get('/products/trending', validateQuery(limitQuerySchema), controller.listTrending)
catalogRouter.get('/products/featured', validateQuery(limitQuerySchema), controller.listFeatured)
catalogRouter.get(
  '/products/new-arrivals',
  validateQuery(limitQuerySchema),
  controller.listNewArrivals,
)
catalogRouter.get(
  '/products/best-sellers',
  validateQuery(limitQuerySchema),
  controller.listBestSellers,
)

/* Batch + search --------------------------------------------------- */
catalogRouter.get('/products/batch', validateQuery(slugsQuerySchema), controller.getProductsBatch)
catalogRouter.get(
  '/search',
  searchLimiter,
  validateQuery(searchQuerySchema),
  controller.searchProducts,
)

/* Product listing and detail --------------------------------------- */
catalogRouter.get('/products', validateQuery(productQuerySchema), controller.listProducts)

// Declared last: a literal route such as /products/trending must be matched
// before this catch-all, or "trending" would be read as a product slug.
catalogRouter.get('/products/:slug', validateParams(slugParamSchema), controller.getProduct)
catalogRouter.get(
  '/products/:slug/related',
  validateParams(slugParamSchema),
  validateQuery(limitQuerySchema),
  controller.getRelated,
)
