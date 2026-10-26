import type { Client } from "@elastic/elasticsearch"
import { DatasetsIndex, FairMBidsSubjectsIndex } from "@fmbids-openneuro/search"

/**
 * Setup any indices and mappings in elasticsearch
 */
export const createIndices = async (elasticClient: Client): Promise<void> => {
  for (const { name, mapping } of [DatasetsIndex, FairMBidsSubjectsIndex]) {
    const exists = await elasticClient.indices.exists({ index: name })
    if (!exists) {
      await elasticClient.indices.create({ index: name, mappings: mapping })
    }
  }
}
