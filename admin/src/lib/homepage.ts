/**
 * What can be edited on each homepage block (Website → Homepage), and the
 * text the website shows today. A form opens pre-filled with the saved copy,
 * or with this text when nothing has been saved yet, so saving without
 * changes keeps the page exactly as it is.
 */

export type SectionField =
  | 'eyebrow'
  | 'heading'
  | 'subheading'
  | 'body'
  | 'imageUrl'
  | 'imageAlt'
  | 'href'
  | 'linkLabel'
  | 'secondaryHref'
  | 'secondaryLinkLabel'

export type ItemField = 'eyebrow' | 'heading' | 'body' | 'imageUrl' | 'imageAlt' | 'href' | 'linkLabel'

export interface SectionItem {
  key?: string
  eyebrow?: string
  heading?: string
  body?: string
  imageUrl?: string
  imageAlt?: string
  href?: string
  linkLabel?: string
}

export interface FieldSpec {
  label: string
  hint?: string
  /** Multi-line text. */
  long?: boolean
  required?: boolean
}

export interface SectionSpec {
  label: string
  description: string
  fields: Partial<Record<SectionField, FieldSpec>>
  defaults: Partial<Record<SectionField, string>>
  items?: {
    title: string
    itemLabel: string
    fields: Partial<Record<ItemField, FieldSpec>>
    defaults: SectionItem[]
    max: number
    /** One entry per fixed slot (e.g. per menu); entries cannot be added or removed. */
    fixed?: boolean
  }
  /** Banner placement that replaces this block when an active banner uses it. */
  bannerPlacement?: string
}

const IMAGE: FieldSpec = { label: 'Image', hint: 'Upload, or a /images/… path or https:// URL.' }
const ALT: FieldSpec = { label: 'Image description', hint: 'Describes the image for screen readers and Google.' }
const EYEBROW: FieldSpec = { label: 'Eyebrow', hint: 'Small uppercase line above the heading.' }
const LINK: FieldSpec = { label: 'Link', hint: 'A path such as /collections/gifting, or an https:// link.' }

const RAIL_FIELDS: SectionSpec['fields'] = {
  heading: { label: 'Heading', required: true },
  subheading: { label: 'Text under the heading', long: true },
  href: { label: '“View all” link' },
  linkLabel: { label: '“View all” label' },
}

export const MENU_SECTION_KEY = 'menu-features'

export const SECTION_SPECS: Record<string, SectionSpec> = {
  hero: {
    label: 'Hero',
    description: 'The full-width artwork at the top, with two buttons.',
    bannerPlacement: 'HOME_HERO',
    fields: {
      imageUrl: { ...IMAGE, hint: 'Shown whole at 16:9. The title is part of the artwork.' },
      imageAlt: ALT,
      heading: { label: 'Page title (read by screen readers and Google)', required: true },
      href: { label: 'First button link' },
      linkLabel: { label: 'First button label' },
      secondaryHref: { label: 'Second button link' },
      secondaryLinkLabel: { label: 'Second button label' },
    },
    defaults: {
      imageUrl: '/images/editorial/hero-kashmiri-shawls.png',
      imageAlt:
        'Pashmore — The Art of Kashmiri Shawls: six Pashmina shawls draped over wooden gift boxes before snow-capped Himalayan peaks',
      heading: 'Pashmore — The Art of Kashmiri Shawls',
      href: '/collections/pure-pashmina',
      linkLabel: 'Explore Collection',
      secondaryHref: '/craftsmanship',
      secondaryLinkLabel: 'Discover Our Craft',
    },
  },
  'editorial-intro': {
    label: 'The Art of Indian Craft',
    description: 'Text beside a portrait image, just under the hero.',
    fields: {
      eyebrow: EYEBROW,
      heading: { label: 'Heading', required: true },
      subheading: { label: 'First paragraph', long: true },
      body: { label: 'More paragraphs', long: true, hint: 'Leave a blank line between paragraphs.' },
      imageUrl: IMAGE,
      imageAlt: ALT,
      href: LINK,
      linkLabel: { label: 'Link label' },
    },
    defaults: {
      eyebrow: 'Our Craft',
      heading: 'The Art of Indian Craft',
      subheading:
        'Discover timeless textiles shaped by generations of craftsmanship, refined for the modern wardrobe.',
      body: 'Every Pashmore piece begins on the Changthang plateau, where pashm is combed by hand from Changthangi goats each spring, and ends in a Srinagar workshop where a single shawl can occupy one loom for six weeks. Nothing in between is hurried.',
      imageUrl: '/images/editorial/editorial-art-of-craft.png',
      imageAlt: 'Undyed Pashmina yarn resting on a hand-carved wooden charkha in a Srinagar workshop',
      href: '/about',
      linkLabel: 'Discover Our Story',
    },
  },
  'category-cards': {
    label: 'Shop by category',
    description: 'Four image cards linking to collections.',
    fields: {
      linkLabel: { label: 'Card link label', hint: 'The small link under each card heading.' },
    },
    defaults: { linkLabel: 'Explore' },
    items: {
      title: 'Cards',
      itemLabel: 'Card',
      max: 8,
      fields: {
        eyebrow: { label: 'Label', hint: 'e.g. Men' },
        heading: { label: 'Heading', required: true },
        href: { ...LINK, required: true },
        imageUrl: { ...IMAGE, required: true },
        imageAlt: ALT,
      },
      defaults: [
        {
          eyebrow: 'Men',
          heading: 'Cut to hang, not to wrap',
          href: '/collections/mens-shawls',
          imageUrl: '/images/categories/category-men.png',
          imageAlt: 'Pashmore men’s charcoal Pashmina shawl folded across a dark wooden bench',
        },
        {
          eyebrow: 'Women',
          heading: 'Six weeks on a single loom',
          href: '/collections/womens-shawls',
          imageUrl: '/images/categories/category-women.png',
          imageAlt:
            'Pashmore women’s ivory Pashmina shawl with hand-embroidered border, draped over a marble ledge',
        },
        {
          eyebrow: 'Pashmina',
          heading: 'Nothing blended, nothing substituted',
          href: '/collections/pure-pashmina',
          imageUrl: '/images/categories/category-pashmina.png',
          imageAlt: 'Close detail of undyed pure Pashmina cloth showing the hand-spun weave',
        },
        {
          eyebrow: 'Gifting',
          heading: 'Presented in hand-bound boxes',
          href: '/collections/gifting',
          imageUrl: '/images/categories/category-gifting.png',
          imageAlt: 'A Pashmore lacquered gift box in deep burgundy holding a folded Pashmina stole',
        },
      ],
    },
  },
  'new-arrivals': {
    label: 'New Arrivals',
    description: 'Product carousel of the newest products.',
    fields: RAIL_FIELDS,
    defaults: {
      heading: 'New Arrivals',
      subheading: 'Fresh expressions of timeless craftsmanship.',
      href: '/collections/new-arrivals',
      linkLabel: 'View all new arrivals',
    },
  },
  'featured-products': {
    label: 'Featured products',
    description: 'Product carousel of products marked Featured in Merchandising.',
    fields: RAIL_FIELDS,
    defaults: {
      heading: 'Featured',
      subheading: 'Chosen by our atelier.',
      href: '/collections/best-sellers',
      linkLabel: 'View all',
    },
  },
  'featured-banner': {
    label: 'Pure Pashmina',
    description: 'Full-width image with text on the left.',
    bannerPlacement: 'HOME_FEATURED',
    fields: {
      eyebrow: EYEBROW,
      heading: { label: 'Heading', required: true },
      subheading: { label: 'Text', long: true },
      imageUrl: IMAGE,
      imageAlt: ALT,
      href: LINK,
      linkLabel: { label: 'Link label' },
    },
    defaults: {
      eyebrow: 'Crafted for Generations',
      heading: 'Pure Pashmina',
      subheading:
        'Hand-combed at 4,500 metres, charkha-spun, and woven on a wooden handloom by weavers whose names are recorded on every certificate.',
      imageUrl: '/images/editorial/featured-pure-pashmina.png',
      imageAlt: 'A length of pure Pashmina cloth catching low light across its full drape',
      href: '/collections/pure-pashmina',
      linkLabel: 'Discover the collection',
    },
  },
  'heritage-story': {
    label: 'The Soul of Pashmore',
    description: 'A heading with alternating image-and-text chapters.',
    fields: {
      eyebrow: EYEBROW,
      heading: { label: 'Heading', required: true },
      subheading: { label: 'Introduction', long: true },
    },
    defaults: {
      eyebrow: 'Heritage',
      heading: 'The Soul of Pashmore',
      subheading:
        'Three hundred kilometres, four generations and about six weeks separate a Changthangi goat from a finished shawl. This is what happens in between.',
    },
    items: {
      title: 'Chapters',
      itemLabel: 'Chapter',
      max: 6,
      fields: {
        eyebrow: EYEBROW,
        heading: { label: 'Heading', required: true },
        body: { label: 'Text', long: true, hint: 'Leave a blank line between paragraphs.' },
        imageUrl: { ...IMAGE, required: true },
        imageAlt: ALT,
        href: { label: 'Link (optional)' },
        linkLabel: { label: 'Link label' },
      },
      defaults: [
        {
          eyebrow: 'The Fibre',
          heading: 'It begins at four thousand metres',
          body: 'Pashm is the winter underfleece of the Changthangi goat, which lives on the Changthang plateau in Ladakh where temperatures fall below −30°C. The goats are never shorn; the fibre is combed out by hand each spring as they moult.\n\nOne animal yields around 150 grams a year. A single shawl needs the yield of three or four.',
          imageUrl: '/images/editorial/editorial-kashmir.png',
          imageAlt: 'The high Changthang plateau in early spring, where Pashmina fibre is hand-combed',
        },
        {
          eyebrow: 'The Hand',
          heading: 'Spun on a charkha, because machines break it',
          body: 'At twelve to fifteen microns, pashm is roughly half the diameter of fine merino and too delicate for mill spinning. It is spun on a hand charkha, almost always by women, at a rate of a few grams an hour.\n\nThe slight irregularity this leaves in the yarn is the reason handwoven Pashmina looks alive and machine-made imitation looks flat.',
          imageUrl: '/images/editorial/editorial-loom.png',
          imageAlt: 'A weaver’s hands passing weft through a wooden handloom in a Srinagar workshop',
        },
        {
          eyebrow: 'The Workshop',
          heading: 'Every piece is signed by the person who made it',
          body: 'Our workshop sits on the Boulevard in Srinagar, where the same families have woven for us across four generations. Sozni embroiderers work by daylight only; kani weavers read from talim scripts that outdate the building.\n\nEach finished piece carries a certificate recording the fibre grade, the loom number and the name of the weaver. We think that is the least a textile of this kind owes its maker.',
          imageUrl: '/images/editorial/editorial-artisan.png',
          imageAlt: 'A Kashmiri artisan finishing sozni embroidery on a cream Pashmina shawl',
          href: '/craftsmanship',
          linkLabel: 'Read about our craft',
        },
      ],
    },
  },
  'gift-packaging': {
    label: 'Gift Box Packaging',
    description: 'Centred text beside an arched image.',
    bannerPlacement: 'HOME_GIFT_PACKAGING',
    fields: {
      eyebrow: { label: 'Small line above', hint: 'e.g. Complimentary' },
      heading: { label: 'Heading', required: true },
      subheading: { label: 'Line below', hint: 'e.g. On All Prepaid Orders' },
      imageUrl: { ...IMAGE, hint: 'Shown in an arch. A square image works best.' },
      imageAlt: ALT,
    },
    defaults: {
      eyebrow: 'Complimentary',
      heading: 'Gift Box Packaging',
      subheading: 'On All Prepaid Orders',
      imageUrl: '/images/editorial/gifting-box.png',
      imageAlt: 'A Pashmore presentation gift box beside an embroidered Pashmina shawl',
    },
  },
  'best-sellers': {
    label: 'Most Loved',
    description: 'Grid of best-selling products.',
    fields: { eyebrow: EYEBROW, ...RAIL_FIELDS },
    defaults: {
      eyebrow: 'Best Sellers',
      heading: 'Most Loved',
      subheading: 'The pieces our customers return to, ranked by what actually sells.',
      href: '/collections/best-sellers',
      linkLabel: 'View all',
    },
  },
  trending: {
    label: 'Trending Now',
    description: 'Product carousel of products marked Trending in Merchandising.',
    fields: RAIL_FIELDS,
    defaults: {
      heading: 'Trending Now',
      subheading: 'What our clients are reaching for this season.',
      href: '/collections/best-sellers',
      linkLabel: 'View all',
    },
  },
  'gifting-banner': {
    label: 'The Art of Gifting',
    description: 'Image beside a dark panel with two buttons.',
    bannerPlacement: 'HOME_GIFTING',
    fields: {
      eyebrow: EYEBROW,
      heading: { label: 'Heading', required: true },
      subheading: { label: 'Text', long: true },
      imageUrl: IMAGE,
      imageAlt: ALT,
      href: { label: 'First button link' },
      linkLabel: { label: 'First button label' },
      secondaryHref: { label: 'Second button link' },
      secondaryLinkLabel: { label: 'Second button label' },
    },
    defaults: {
      eyebrow: 'Gifting',
      heading: 'The Art of Gifting',
      subheading:
        'Thoughtfully crafted pieces for moments worth remembering. Every gift is presented in a hand-bound box from a Srinagar bookbinder, with a muslin sleeve, a craft certificate and a hand-written card.',
      imageUrl: '/images/editorial/gifting-box.png',
      imageAlt:
        'A Pashmore lacquered presentation box, muslin sleeve and craft certificate arranged on linen',
      href: '/collections/gifting',
      linkLabel: 'Shop Gifts',
      secondaryHref: '/corporate-gifts',
      secondaryLinkLabel: 'Corporate Gifting',
    },
  },
  'social-grid': {
    label: 'Follow the World of Pashmore',
    description: 'A row of Instagram images.',
    fields: {
      eyebrow: { label: 'Small line above', hint: 'e.g. @pashmore' },
      heading: { label: 'Heading', required: true },
      href: { label: 'Instagram profile link', hint: 'Every image opens this link.' },
    },
    defaults: {
      eyebrow: '@pashmore',
      heading: 'Follow the World of Pashmore',
      href: 'https://www.instagram.com/pashmore',
    },
    items: {
      title: 'Images',
      itemLabel: 'Image',
      max: 8,
      fields: {
        imageUrl: { ...IMAGE, required: true, hint: 'Square images work best.' },
        imageAlt: ALT,
      },
      defaults: [
        { imageUrl: '/images/social/instagram-1.png', imageAlt: 'An ivory Pashmina shawl styled over a linen shirt' },
        { imageUrl: '/images/social/instagram-2.png', imageAlt: 'A charcoal men’s shawl photographed on a dark wooden table' },
        { imageUrl: '/images/social/instagram-3.png', imageAlt: 'Hand-spun Pashmina yarn wound on a wooden charkha' },
        { imageUrl: '/images/social/instagram-4.png', imageAlt: 'A burgundy kani shawl detail showing the woven pallav' },
        { imageUrl: '/images/social/instagram-5.png', imageAlt: 'A cream Pashmina wrap folded beside a muslin sleeve' },
        { imageUrl: '/images/social/instagram-6.png', imageAlt: 'A mist grey stole draped over a chair in morning light' },
        { imageUrl: '/images/social/instagram-7.png', imageAlt: 'Antique gold jamawar weave photographed close up' },
        { imageUrl: '/images/social/instagram-8.png', imageAlt: 'A dusty rose cashmere wrap on a marble surface' },
      ],
    },
  },
  [MENU_SECTION_KEY]: {
    label: 'Menu feature cards',
    description: 'The image card on the right of each desktop menu (Men, Women, Collections, Gifting).',
    fields: {},
    defaults: {},
    items: {
      title: 'Cards',
      itemLabel: 'Menu',
      max: 4,
      fixed: true,
      fields: {
        eyebrow: EYEBROW,
        heading: { label: 'Heading', required: true },
        href: LINK,
        linkLabel: { label: 'Link label' },
        imageUrl: { ...IMAGE, hint: 'Portrait (4:5) works best.' },
        imageAlt: ALT,
      },
      defaults: [
        {
          key: 'Men',
          eyebrow: 'The Men’s Edit',
          heading: 'Shawls cut to hang, not to wrap',
          href: '/collections/mens-shawls',
          linkLabel: 'Explore men’s shawls',
          imageUrl: '/images/menu/menu-men.png',
          imageAlt: 'Pashmore men’s charcoal Pashmina shawl folded over a chair',
        },
        {
          key: 'Women',
          eyebrow: 'New This Season',
          heading: 'Ombré Pashmina, dipped by hand',
          href: '/collections/new-arrivals',
          linkLabel: 'See new arrivals',
          imageUrl: '/images/menu/menu-women.png',
          imageAlt: 'Pashmore women’s cream Pashmina shawl draped over a marble ledge',
        },
        {
          key: 'Collections',
          eyebrow: 'Crafted for Generations',
          heading: 'The Pure Pashmina collection',
          href: '/collections/pure-pashmina',
          linkLabel: 'Discover the collection',
          imageUrl: '/images/menu/menu-collections.png',
          imageAlt: 'Undyed Pashmina yarn on a wooden charkha in a Srinagar workshop',
        },
        {
          key: 'Gifting',
          eyebrow: 'The Art of Gifting',
          heading: 'Presented in hand-bound boxes',
          href: '/collections/gifting',
          linkLabel: 'Shop gifts',
          imageUrl: '/images/menu/menu-gifting.png',
          imageAlt: 'Pashmore lacquered gift box with a folded Pashmina stole inside',
        },
      ],
    },
  },
}

/** The names the sections were seeded with; treated as "nothing saved yet". */
export const SEED_HEADINGS = new Set([
  'Hero',
  'Editorial introduction',
  'Shop by category',
  'Featured banner',
  'Heritage story',
  'Gift packaging banner',
  'Gifting banner',
  'Trust bar',
  'Recently viewed',
  'Social grid',
])
