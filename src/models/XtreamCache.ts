import {
  Table,
  Column,
  Model,
  DataType,
  PrimaryKey,
} from "sequelize-typescript";

@Table({
  tableName: "xtream_cache",
  timestamps: false,
})
export class XtreamCache extends Model {
  @PrimaryKey
  @Column(DataType.STRING)
  key!: string;

  @Column(DataType.TEXT)
  value!: string;

  @Column(DataType.DATE)
  expiresAt!: Date;
}
