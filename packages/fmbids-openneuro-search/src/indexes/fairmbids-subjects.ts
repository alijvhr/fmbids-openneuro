import fairMBidsSubjectsMapping from "../mappings/fairmbids-subjects-mapping.json"
import { elasticMappingName } from "../names"

/** One document per dataset-local subject of a FAIR m-BIDS snapshot */
export const FairMBidsSubjectsIndex = {
  name: elasticMappingName("fairmbids-subjects", fairMBidsSubjectsMapping),
  mapping: fairMBidsSubjectsMapping,
}

export default FairMBidsSubjectsIndex
