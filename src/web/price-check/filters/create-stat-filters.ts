import { ParsedItem, ItemRarity, ItemCategory } from '@/parser'
import { ModifierType, StatCalculated, statSourcesTotal, translateStatWithRoll } from '@/parser/modifiers'
import { uniqueModFilterPartial } from './unique-roll'
import { percentRoll, roundRoll } from './util'
import { FilterTag, ItemHasEmptyModifier, StatFilter } from './interfaces'
import { filterPseudo } from './pseudo'
import { filterItemProp } from './pseudo/item-property'
import { filterUniqueItemProp } from './pseudo/item-property-unique'
import { StatBetter } from '@/assets/data'

export interface FiltersCreationContext {
  readonly item: ParsedItem
  readonly searchInRange: number
  filters: StatFilter[]
  statsByType: StatCalculated[]
}

export function initUiModFilters (
  item: ParsedItem,
  opts: {
    searchStatRange: number
  }
): StatFilter[] {
  if (
    (item.rarity === ItemRarity.Unique && item.category === ItemCategory.Map) ||
    item.category === ItemCategory.MavenInvitation
  ) {
    return []
  }

  const ctx: FiltersCreationContext = {
    item,
    filters: [],
    searchInRange: opts.searchStatRange,
    statsByType: item.statsByType.map(calc => {
      if (calc.type === ModifierType.Fractured && calc.stat.trade.ids[ModifierType.Explicit]) {
        return { ...calc, type: ModifierType.Explicit }
      } else {
        return calc
      }
    })
  }

  if (!item.isUnidentified) {
    if (item.rarity === ItemRarity.Unique) {
      filterUniqueItemProp(ctx)
    } else {
      filterItemProp(ctx)
      filterPseudo(ctx)
    }
  }

  if (!item.isCorrupted && !item.isMirrored) {
    ctx.statsByType = ctx.statsByType.filter(mod => mod.type !== ModifierType.Fractured)
    ctx.statsByType.push(...item.statsByType.filter(mod => mod.type === ModifierType.Fractured))
  }

  if (item.isVeiled) {
    ctx.statsByType = ctx.statsByType.filter(mod => mod.type !== ModifierType.Veiled)
  }

  ctx.filters.push(
    ...ctx.statsByType.map(mod => calculatedStatToFilter(mod, item, { percent: ctx.searchInRange }))
  )

  if (!item.isCorrupted && !item.isMirrored && item.isSynthesised) {
    const transformedImplicits = item.statsByType.filter(mod =>
      mod.type === ModifierType.Implicit &&
      !ctx.statsByType.includes(mod))

    const synthImplicitFilters = transformedImplicits.map(mod => calculatedStatToFilter(mod, item, { percent: ctx.searchInRange }))
    for (const filter of synthImplicitFilters) {
      filter.hidden = 'Select only if price-checking as base item for crafting'
    }
    ctx.filters.push(...synthImplicitFilters)
  }

  if (item.isUnidentified && item.rarity === ItemRarity.Unique) {
    ctx.filters = ctx.filters.filter(f => !f.hidden)
  }

  if (item.isVeiled) {
    ctx.filters.forEach(filter => { filter.disabled = true })
  }

  if (item.category === ItemCategory.Map) {
    ctx.filters = ctx.filters.filter(f => f.tag !== 'explicit')
  }

  finalFilterTweaks(ctx)

  return ctx.filters
}

export function calculatedStatToFilter (
  calc: StatCalculated,
  item: ParsedItem,
  opts: { percent: number }
): StatFilter {
  const { stat, sources, type } = calc

  if (stat.trade.option) {
    return {
      tradeId: stat.trade.ids[type],
      statRef: stat.ref,
      text: sources[0].stat.translation.string,
      tag: type as unknown as FilterTag,
      sources: sources,
      option: {
        value: sources[0].contributes!.value,
        tradeValue: stat.trade.option
      },
      disabled: true
    }
  }

  const roll = statSourcesTotal(calc.sources)
  const translation = translateStatWithRoll(calc, roll)

  const filter: StatFilter = {
    tradeId: stat.trade.ids[type],
    statRef: stat.ref,
    text: translation.string,
    tag: type as unknown as FilterTag,
    sources: sources,
    roll: undefined,
    disabled: true
  }

  if (roll) {
    const dp =
      calc.stat.dp ||
      calc.sources.some(s => s.stat.stat.ref === calc.stat.ref && s.stat.roll!.dp)

    if (
      item.rarity === ItemRarity.Unique &&
      calc.type !== ModifierType.Enchant
    ) {
      uniqueModFilterPartial(item, roll, filter, (opts.percent * 2), dp)
    } else {
      const percent = (calc.type === ModifierType.Enchant)
        ? 0
        : opts.percent

      filter.roll = {
        value: roundRoll(roll.value, dp),
        min: undefined,
        max: undefined,
        default: {
          min: percentRoll(roll.value, -percent, Math.floor, dp),
          max: percentRoll(roll.value, +percent, Math.ceil, dp)
        },
        dp: dp,
        isNegated: false
      }
    }
  }

  filterAdjustmentForNegate(calc, translation.negate, filter)

  return filter
}

function filterAdjustmentForNegate (
  calc: StatCalculated,
  negate: boolean,
  filter: StatFilter
) {
  if (!filter.roll) return

  const { roll } = filter

  if (roll.min == null && roll.max == null) {
    switch (calc.stat.better) {
      case StatBetter.PositiveRoll:
        roll.min = roll.default.min
        break
      case StatBetter.NegativeRoll:
        roll.max = roll.default.max
        break
      case StatBetter.NotComparable:
        roll.min = roll.default.min
        roll.max = roll.default.max
        break
    }
  }

  if (negate) {
    roll.tradeInvert = true
    roll.isNegated = true
    const swap = JSON.parse(JSON.stringify(roll)) as typeof roll

    if (swap.bounds) {
      roll.bounds!.min = -1 * swap.bounds.max
      roll.bounds!.max = -1 * swap.bounds.min
    }

    roll.default.min = -1 * swap.default.max
    roll.default.max = -1 * swap.default.min

    roll.value = -1 * swap.value
    roll.min = (typeof swap.max === 'number')
      ? -1 * swap.max
      : undefined
    roll.max = (typeof swap.min === 'number')
      ? -1 * swap.min
      : undefined
  }

  if (calc.stat.trade.inverted) {
    roll.tradeInvert = !roll.tradeInvert
  }
}

function finalFilterTweaks (ctx: FiltersCreationContext) {
  const { item } = ctx

  if (item.category === ItemCategory.ClusterJewel && item.rarity !== ItemRarity.Unique) {
    for (const filter of ctx.filters) {
      if (filter.tag === 'enchant') {
        if (filter.statRef === '# Added Passive Skills are Jewel Sockets') {
          filter.hidden = 'Roll is not variable'
        }
        if (filter.statRef === 'Added Small Passive Skills grant: #') {
          filter.disabled = false
        }
        if (filter.statRef === 'Adds # Passive Skills') {
          // https://pathofexile.gamepedia.com/Cluster_Jewel#Optimal_passive_skill_amounts
          filter.disabled = false
          filter.roll!.min = undefined
          if (filter.roll!.max === 4) {
            filter.roll!.max = 5
          }
        }
      }
    }
  }

  if (item.category === ItemCategory.Map) {
    const isInfluenced = ctx.filters.find(filter => filter.statRef === 'Area is influenced by #')
    const isElderGuardian = ctx.filters.find(filter => filter.statRef === 'Map is occupied by #')
    if (isInfluenced && !isElderGuardian && isInfluenced.roll!.value === 2 /* TODO: hardcoded */) {
      const idx = ctx.filters.indexOf(isInfluenced)
      ctx.filters.splice(idx + 1, 0, {
        tradeId: ['map.no_elder_guardian'],
        text: 'Map is not occupied by Elder Guardian',
        statRef: 'Map is not occupied by Elder Guardian',
        disabled: false,
        tag: FilterTag.Implicit,
        sources: []
      })
    }
    if (isInfluenced) {
      isInfluenced.disabled = false
    }
    if (isElderGuardian) {
      isElderGuardian.disabled = false
    }
  }

  const hasEmptyModifier = showHasEmptyModifier(ctx)
  if (hasEmptyModifier !== false) {
    ctx.filters.push({
      tradeId: ['item.has_empty_modifier'],
      text: '1 Empty or Crafted Modifier',
      statRef: '1 Empty or Crafted Modifier',
      disabled: true,
      hidden: 'Select only if item has 6 modifiers (1 of which is crafted) or if it has 5 modifiers',
      tag: FilterTag.Pseudo,
      sources: [],
      option: {
        value: hasEmptyModifier,
        tradeValue: 'num'
      }
    })
  }

  if (item.category === ItemCategory.Amulet) {
    const anointment = ctx.filters.find(filter => filter.statRef === 'Allocates #')
    if (anointment) {
      if (item.props.talismanTier) {
        anointment.disabled = false
      } else if (!item.isCorrupted && !item.isMirrored) {
        anointment.hidden = 'Buyer will likely change anointment'
      }
    }
  }

  for (const filter of ctx.filters) {
    if (filter.tag === FilterTag.Fractured) {
      const mod = ctx.item.statsByType.find(mod => mod.stat.ref === filter.statRef)!
      if (mod.stat.trade.ids[ModifierType.Explicit]) {
        // hide only if fractured mod has corresponding explicit variant
        filter.hidden = 'Select only if price-checking as base item for crafting'
      }
    }
  }
}

// TODO
// +1 Prefix Modifier allowed
// -1 Suffix Modifier allowed
function showHasEmptyModifier (ctx: FiltersCreationContext): ItemHasEmptyModifier | false {
  const { item } = ctx

  if (
    item.rarity !== ItemRarity.Rare ||
    item.isCorrupted ||
    item.isMirrored
  ) return false

  const randomMods = item.newMods.filter(mod =>
    mod.info.type === ModifierType.Explicit ||
    mod.info.type === ModifierType.Fractured ||
    mod.info.type === ModifierType.Veiled ||
    mod.info.type === ModifierType.Crafted)

  const craftedMod = randomMods.find(mod => mod.info.type === ModifierType.Crafted)

  if (
    (randomMods.length === 5 && !craftedMod) ||
    (randomMods.length === 6 && craftedMod)
  ) {
    let prefixes = randomMods.filter(mod => mod.info.generation === 'prefix').length
    let suffixes = randomMods.filter(mod => mod.info.generation === 'suffix').length

    if (craftedMod) {
      if (craftedMod.info.generation === 'prefix') {
        prefixes -= 1
      } else {
        suffixes -= 1
      }
    }

    if (prefixes === 2) return ItemHasEmptyModifier.Prefix
    if (suffixes === 2) return ItemHasEmptyModifier.Suffix
  }

  return false
}
